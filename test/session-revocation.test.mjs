// Real-time session recheck: logout, expiry or account change must stop already-open sockets.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { patchRouter, patchSessionSockets, anchors } from '../runtime/session-revocation/apply.mjs';

function handshake(stored, error = null) {
  const socket = {}, session = { passport: { user: { _id: 'u1' } } };
  const source = `(function (sessionStore, sessionId, session, socket, metrics) {\n  function next() {}\n${anchors.signed}\n})`;
  vm.runInNewContext(patchSessionSockets(source))({ get: (id, cb) => { assert.equal(id, 'sid'); cb(error, stored); } }, 'sid', session, socket, { inc() {} });
  return new Promise(resolve => socket.olSessionStillValid((err, valid) => resolve({ err, valid })));
}

test('the stored session must still exist and belong to the same account', async () => {
  assert.deepEqual(await handshake({ passport: { user: { _id: 'u1' } } }), { err: null, valid: true });
  assert.deepEqual(await handshake(null), { err: null, valid: false }, 'logged out');
  assert.deepEqual(await handshake({ passport: { user: { _id: 'u2' } } }), { err: null, valid: false }, 'another account on the same cookie');
  const failed = await handshake(undefined, Error('redis down')); assert.equal(failed.err.message, 'redis down');
});

function router() {
  const calls = [];
  const source = `(function (logger, WebsocketController) {
const Router = {
${anchors.handleError}
    callback(error)
  },
}
function onOt(client, docId, update, callback) {
${anchors.otCall}
}
function onJoin(client, docId, fromVersion, options, callback) {
${anchors.joinCall}
}
return { onOt, onJoin }
})`;
  const api = vm.runInNewContext(patchRouter(source))({ debug() {} }, {
    applyOtUpdate: (client, doc, update, cb) => { calls.push('ot'); cb(); },
    joinDoc: (client, doc, from, options, cb) => { calls.push('join'); cb(null, ['line'], 3); },
  });
  return { api, calls };
}
const client = valid => ({ id: 'c', disconnects: 0, disconnect() { this.disconnects++; },
  ...(valid === 'missing' ? {} : { olSessionStillValid: cb => (valid instanceof Error ? cb(valid) : cb(null, valid)) }) });

test('writes and document reads proceed only with a live session', () => {
  const { api, calls } = router(), live = client(true), acked = [];
  api.onOt(live, 'd', {}, () => acked.push('ot')); api.onJoin(live, 'd', -1, {}, (e, ...args) => acked.push(['join', args]));
  assert.deepEqual(calls, ['ot', 'join']); assert.deepEqual(acked, ['ot', ['join', [['line'], 3]]]); assert.equal(live.disconnects, 0);
});

test('ended, failed or missing session checks disconnect without acknowledging or applying', () => {
  for (const state of [false, Error('store'), 'missing']) {
    const { api, calls } = router(), ended = client(state);
    api.onOt(ended, 'd', {}, () => assert.fail('An ended session must not be acknowledged'));
    api.onJoin(ended, 'd', -1, {}, () => assert.fail('An ended session must not read documents'));
    assert.deepEqual(calls, []); assert.equal(ended.disconnects, 2);
  }
});

test('patches refuse changed upstream source or a second application', () => {
  assert.throws(() => patchSessionSockets('changed'), /handshake differs/);
  assert.throws(() => patchRouter('changed'), /router differs/);
  const once = patchSessionSockets(anchors.signed);
  assert.throws(() => patchSessionSockets(once + anchors.signed), /already installed/);
});
