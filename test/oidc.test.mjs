import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const root = process.env.OIDC_SOURCE_DIR ? new URL('file://' + process.env.OIDC_SOURCE_DIR + '/') : new URL('../integrations/ce-plus-oidc/', import.meta.url);
async function load(file, imports) {
  const context = vm.createContext({ process: { env: {} } });
  const module = new vm.SourceTextModule(readFileSync(new URL(file, root), 'utf8'), { context });
  await module.link(specifier => {
    assert(Object.hasOwn(imports, specifier), `Unexpected dependency: ${specifier}`);
    const exports = imports[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace.default;
}
function profile() {
  return { id: 'provider-subject', emails: [{ value: 'person@example.test' }], _json: { sub: 'provider-subject', email: 'person@example.test', email_verified: true } };
}
async function managerFixture() {
  class Missing extends Error {}
  class Parallel extends Error {}
  const settings = { oidc: { attUserId: 'id', providerId: 'google' } };
  const user = { _id: 'local-user', email: 'person@example.test', loginEpoch: 0, thirdPartyIdentifiers: [] };
  const state = { queries: 0, creates: [], links: [], updates: 0, existing: null, race: false };
  const identity = { promises: {
    login: async () => { throw new Missing() },
    link: async (...args) => {
      state.links.push(args);
      assert.equal(args[5], true, 'Must disable native unlink-and-replace fallback');
      if (state.race || user.thirdPartyIdentifiers.some(x => x.providerId === args[1])) throw new Error('update failed');
      user.thirdPartyIdentifiers.push({ providerId: args[1], externalUserId: args[2] });
    },
  } };
  const model = {
    findOne: () => { state.queries++; return { exec: async () => state.existing } },
    updateOne: () => { state.updates++; return { exec: async () => ({ modifiedCount: 1 }) } },
  };
  const manager = (await load('OIDCAuthenticationManager.mjs', {
    'node:crypto': { default: crypto },
    '@overleaf/settings': { default: settings },
    '../../../../../app/src/Features/User/UserCreator.mjs': { default: { promises: { createNewUser: async attrs => { state.creates.push(attrs); return user } } } },
    '../../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs': { default: identity },
    '../../../../../app/src/Features/Authentication/AuthenticationErrors.mjs': { ParallelLoginError: Parallel },
    '../../../../../app/src/models/User.mjs': { User: model },
    '../../../../../app/src/Features/Errors/Errors.js': { default: { ThirdPartyUserNotFoundError: Missing } },
  })).promises;
  return { manager, state, user, settings, identity, model };
}
const invalid = [
  ['missing profile', () => null],
  ['missing email', p => { p.emails = []; return p }],
  ['missing raw claims', p => { delete p._json; return p }],
  ['unverified email', p => { p._json.email_verified = false; return p }],
  ['string verification', p => { p._json.email_verified = 'true'; return p }],
  ['missing verification', p => { delete p._json.email_verified; return p }],
  ['different raw email', p => { p._json.email = 'other@example.test'; return p }],
  ['different raw subject', p => { p._json.sub = 'other-subject'; return p }],
  ['missing subject', p => { p.id = ''; return p }],
];
for (const [name, mutate] of invalid) {
  test(`OIDC rejects ${name} before login or explicit linking writes`, async () => {
    const f = await managerFixture();
    const p = mutate(profile());
    await assert.rejects(f.manager.findOrCreateUser(p, {}), { status: 403 });
    await assert.rejects(f.manager.linkAccount('local-user', p, {}), { status: 403 });
    assert.equal(f.state.queries + f.state.creates.length + f.state.links.length + f.state.updates, 0);
  });
}
test('verified new identity gets no local password and an atomic subject link', async () => {
  const f = await managerFixture();
  assert.equal(await f.manager.findOrCreateUser(profile(), {}), f.user);
  assert.equal(f.state.creates.length, 1);
  assert(!Object.hasOwn(f.state.creates[0], 'password'));
  assert(!Object.hasOwn(f.state.creates[0], 'hashedPassword'));
  assert.equal(f.state.links[0][2], 'provider-subject');
  assert.equal(f.state.updates, 2);
});
test('verified email can link an existing local account without replacing identity', async () => {
  const f = await managerFixture(); f.state.existing = f.user;
  await f.manager.findOrCreateUser(profile(), {});
  assert.equal(f.state.creates.length, 0); assert.equal(f.state.links.length, 1);
});
test('existing subject login does not relink', async () => {
  const f = await managerFixture();
  f.user.thirdPartyIdentifiers.push({ providerId: 'google', externalUserId: 'provider-subject' });
  f.identity.promises.login = async () => f.user;
  await f.manager.findOrCreateUser(profile(), {});
  assert.equal(f.state.queries + f.state.links.length + f.state.creates.length, 0);
});
test('a native lookup matching different array entries cannot authenticate the wrong subject', async () => {
  const f = await managerFixture();
  f.user.thirdPartyIdentifiers.push({ providerId: 'google', externalUserId: 'someone-else' }, { providerId: 'other', externalUserId: 'provider-subject' });
  f.identity.promises.login = async () => f.user;
  await assert.rejects(f.manager.findOrCreateUser(profile(), {}), { status: 403 });
  assert.equal(f.state.updates + f.state.links.length, 0);
});
test('database failure does not fall back to email lookup or mutate accounts', async () => {
  const f = await managerFixture(); const failure = new Error('database unavailable');
  f.identity.promises.login = async () => { throw failure };
  await assert.rejects(f.manager.findOrCreateUser(profile(), {}), e => e === failure);
  assert.equal(f.state.queries + f.state.links.length + f.state.creates.length, 0);
});
test('a different existing provider identity is held', async () => {
  const f = await managerFixture(); f.state.existing = f.user;
  f.user.thirdPartyIdentifiers.push({ providerId: 'google', externalUserId: 'original-subject' });
  await assert.rejects(f.manager.findOrCreateUser(profile(), {}), { status: 409 });
  assert.equal(f.state.links.length + f.state.updates, 0);
});
test('a competing link fails without replacement in automatic and explicit flows', async () => {
  for (const explicit of [false, true]) {
    const f = await managerFixture(); f.state.race = true; f.state.existing = f.user;
    await assert.rejects(explicit ? f.manager.linkAccount('local-user', profile(), {}) : f.manager.findOrCreateUser(profile(), {}), /update failed/);
    assert.equal(f.user.thirdPartyIdentifiers.length + f.state.updates, 0);
  }
});
test('JIT domain policy and subject mapping remain fail closed', async () => {
  const f = await managerFixture(); f.settings.oidc.allowedOIDCEmailDomains = [];
  assert.equal(await f.manager.findOrCreateUser(profile(), {}), null);
  assert.equal(f.state.creates.length + f.state.links.length, 0);
  f.settings.oidc.attUserId = 'email';
  await assert.rejects(f.manager.findOrCreateUser(profile(), {}), /provider subject/);
});
async function controllerFixture() {
  const state = { logout: 0, finished: 0, callbackTask: null, redirect: null, status: null, json: null, user: false, info: { status: 409, text: 'Link refused' } };
  const settings = { siteUrl: 'http://127.0.0.1:8080' };
  const manager = { promises: { findOrCreateUser: async () => ({ _id: 'local-user' }), linkAccount: async () => {} } };
  const controller = await load('OIDCAuthenticationController.mjs', {
    '@overleaf/logger': { default: { debug() {}, error() {} } },
    passport: { default: { authenticate: (_name, _opts, callback) => () => { state.callbackTask = callback(null, state.user, state.info) } } },
    '@overleaf/settings': { default: settings },
    '../../../../../app/src/Features/Authentication/AuthenticationController.mjs': { default: { getAuditInfo: () => ({}), setAuditInfo() {}, promises: { finishLogin: async () => { state.finished++ } } } },
    '../../../../../app/src/Features/User/UserController.mjs': { default: { doLogout: async req => { state.logout++; delete req.session } } },
    '../../../../../app/src/Features/User/ThirdPartyIdentityManager.mjs': { default: {} },
    './OIDCAuthenticationManager.mjs': { default: manager },
  });
  const res = { redirect: url => { state.redirect = url }, status: code => { state.status = code }, json: body => { state.json = body } };
  return { state, settings, manager, controller, res };
}
test('userinfo subject must match ID token subject', async () => {
  const f = await controllerFixture(); let error;
  await f.controller.doPassportLogin({ session: {} }, 'issuer', profile(), { id: 'foreign' }, null, 'token', null, null, null, e => { error = e });
  assert.equal(error.status, 403);
});
test('successful passport verification never returns provider tokens', async () => {
  const f = await controllerFixture(); let result;
  await f.controller.doPassportLogin({ session: {} }, 'issuer', profile(), { id: 'provider-subject' }, null, 'secret-token', null, null, null, (error, user, info) => { result = { error, user, info } });
  assert.equal(result.error, null); assert.equal(result.user._id, 'local-user'); assert.equal(result.info, undefined);
  assert.equal(f.controller.doPassportLogin.length, 10);
});
test('failed account link remains a failure and never redirects', async () => {
  const f = await controllerFixture();
  f.controller.passportLoginCallback({ session: { intent: 'link' } }, f.res, assert.ifError);
  await f.state.callbackTask;
  assert.equal(f.state.redirect, null); assert.equal(f.state.status, 409); assert.equal(f.state.finished, 0);
});
test('successful link returns to settings without provider logout or token URL', async () => {
  const f = await controllerFixture(); f.state.user = true; f.state.info = { idToken: 'secret-token' };
  const req = { session: { intent: 'link', idToken: 'previous-token' } };
  f.controller.passportLoginCallback(req, f.res, assert.ifError);
  await f.state.callbackTask;
  assert(!Object.hasOwn(req.session, 'idToken'));
  assert.equal(f.state.redirect, '/user/settings'); assert.equal(f.state.finished, 0);
});
test('normal login clears any previous provider token in the application session', async () => {
  const f = await controllerFixture(); f.state.user = { _id: 'local-user' }; f.state.info = { idToken: 'secret-token' };
  const req = { session: { idToken: 'previous-token' } };
  f.controller.passportLoginCallback(req, f.res, assert.ifError); await f.state.callbackTask;
  assert(!Object.hasOwn(req.session, 'idToken')); assert.equal(f.state.finished, 1);
});
test('logout destroys the local session before a local redirect', async () => {
  const f = await controllerFixture(); const req = { session: { idToken: 'secret-token' } };
  await f.controller.passportLogout(req, f.res, assert.ifError);
  assert.equal(req.session, undefined); assert.equal(f.state.logout, 1); assert.equal(f.state.redirect, f.settings.siteUrl);
});
test('logout failure propagates without a false success redirect', async () => {
  const f = await controllerFixture(); const req = Object.freeze({ session: {} });
  await assert.rejects(f.controller.passportLogout(req, f.res, assert.ifError)); assert.equal(f.state.redirect, null);
});

test('link handler reports a rejected identity instead of claiming success', async () => {
  const f = await controllerFixture();
  f.manager.promises.linkAccount = async () => { throw Object.assign(new Error('Unverified identity'), { status: 403 }) };
  const result = await f.controller._doLink({ user: { _id: 'local-user' } }, profile());
  assert.equal(result.user, false); assert.equal(result.info.status, 403);
});
test('malformed profile failure is reported without dereferencing or logging its email', async () => {
  const f = await controllerFixture();
  f.manager.promises.findOrCreateUser = async () => { throw Object.assign(new Error('Invalid profile'), { status: 403 }) };
  const result = await f.controller._doLogin({}, null);
  assert.equal(result.user, false); assert.equal(result.info.status, 403);
});
