// SPDX-License-Identifier: AGPL-3.0-only
// P2P-ROOM-01 in memory: lan-host.mjs startHost over p2pHelper and lan-guest.mjs joinSession over p2pSocket, with the in-process
// room finder (p2p-signal.mjs memorySignaling) and a fake RTCPeerConnection pair that, like real stacks, rejects data-channel
// messages over 64 KiB. Checks join + verified snapshot (text, binary, a file over one room frame), live edits, the finder seeing
// no secret or source, refusals and outages. Real WebRTC runs in test/browser/p2p-room.browser.mjs.
// Run: node --test test/p2p-room.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from '../runtime/chrome-extension/lan-host.mjs';
import { joinSession } from '../runtime/chrome-extension/lan-guest.mjs';
import { memorySignaling } from '../runtime/chrome-extension/p2p-signal.mjs';
import { p2pHelper, p2pSocket, QUEUE_LIMIT } from '../runtime/chrome-extension/p2p-transport.mjs';
import { parseJoinLink } from '../runtime/chrome-extension/lan-room.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await tick(); } };
const enc = value => new TextEncoder().encode(value);
const SOURCE = 'MARKER-SOURCE Hello Türkçe 😀\n';
const BIG = Uint8Array.from({ length: 900_000 }, (_, i) => (i * 7919) & 255); // three room chunks, ~40 data-channel pieces

/** Fake WebRTC: an offer's sdp names the offering connection; setRemoteDescription(answer) opens both channel ends. */
const offers = new Map(); let ids = 0;
class FakeChannel {
  constructor(label) { Object.assign(this, { label, readyState: 'connecting', bufferedAmount: 0, other: null, sent: 0 }); }
  send(data) {
    if (this.readyState !== 'open') throw Error('not open');
    if (data.byteLength > 65536) throw Error('message too big'); // what real stacks do past the negotiated limit
    this.sent++;
    if (this.stall) { this.bufferedAmount += data.byteLength; return; }
    const copy = data.slice().buffer; setImmediate(() => this.other.readyState === 'open' && this.other.onmessage?.({ data: copy }));
  }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; setImmediate(() => this.onclose?.()); const o = this.other; if (o && o.readyState !== 'closed') { o.readyState = 'closed'; setImmediate(() => o.onclose?.()); } }
}
class FakePC {
  constructor(config) { Object.assign(this, { config, connectionState: 'new', id: ++ids, channel: null }); }
  createDataChannel(label) { return (this.channel = new FakeChannel(label)); }
  async createOffer() { return { type: 'offer', sdp: `v=0 fake-offer ${this.id}` }; }
  async createAnswer() { return { type: 'answer', sdp: `v=0 fake-answer ${this.id}` }; }
  async setLocalDescription(d) {
    this.localDescription = d; if (d.type === 'offer') offers.set(d.sdp, this);
    setImmediate(() => this.onicecandidate?.({ candidate: { candidate: `candidate:1 1 udp 1 ${this.id}.local 9 typ host`, sdpMid: '0', sdpMLineIndex: 0 } }));
  }
  async setRemoteDescription(d) {
    if (!/^v=0 fake-(offer|answer) \d+$/.test(d.sdp)) throw Error('bad sdp');
    if (d.type === 'offer') { this.offerer = offers.get(d.sdp); if (!this.offerer) throw Error('unknown offer'); return; }
    const answerer = [...FakePC.all].find(p => p.localDescription?.sdp === d.sdp); // the owner's side of this offer
    const mine = this.channel, theirs = new FakeChannel(mine.label); mine.other = theirs; theirs.other = mine;
    setImmediate(() => { answerer.ondatachannel?.({ channel: theirs }); setImmediate(() => { mine.readyState = theirs.readyState = 'open'; theirs.onopen?.(); mine.onopen?.(); }); });
  }
  async addIceCandidate(c) { this.ice = (this.ice ?? 0) + 1; if (!c?.candidate) throw Error('bad candidate'); }
  close() { this.connectionState = 'closed'; this.channel?.close(); }
}
FakePC.all = new Set();
const RTC = class extends FakePC { constructor(c) { super(c); FakePC.all.add(this); } };

async function room({ finder } = {}) {
  const taps = [], signaling = finder ?? memorySignaling({ tap: (...a) => taps.push(a) });
  const files = new Map([['main.tex', enc(SOURCE)], ['fig/plot.bin', BIG]]);
  const source = {
    tree: () => ({ main: 'main.tex', docs: ['main.tex'], files: [...files].map(([path, bytes]) => ({ path, bytes })) }),
    text: path => path === 'main.tex' ? { text: SOURCE, version: 1 } : null,
    persist: () => {},
  };
  const helper = p2pHelper({ signaling, RTC });
  const host = await startHost({ helper, source, onPeers: () => {} });
  const join = (username = 'Ada', passcode = host.passcode, extra = {}) => joinSession({ link: host.link, passcode, username, P2PSocketImpl: p2pSocket({ signaling, RTC }), retries: [], ...extra });
  return { host, helper, signaling, taps, join };
}

test('internet room link carries the room id only and routes to the P2P transport', async () => {
  const { host } = await room();
  assert.match(host.link, /^chrome-extension:\/\/[a-p]{32}\/extension\/index\.html#room=[A-Za-z0-9_-]{22}$/);
  assert.ok(!host.link.includes(host.passcode.replaceAll('-', '')) && !host.link.includes(host.passcode));
  assert.deepEqual(parseJoinLink(host.link), { roomId: host.room.roomId, url: `p2p:${host.room.roomId}`, p2p: true });
  assert.throws(() => parseJoinLink(host.link.replace('#room=', '#room=x')), /not a valid join link/);
  await host.stop();
});

test('join by snapshot over data channels: exact Unicode and binary bytes, live edits both ways, finder sees no secret or source', async () => {
  const { host, taps, join } = await room();
  const ctl = await join('Ada 😀');
  assert.equal(new TextDecoder().decode(ctl.store.read('main.tex')), SOURCE);
  assert.deepEqual(ctl.store.read('fig/plot.bin'), BIG);
  const doc = await ctl.join('main.tex');
  assert.equal(doc.text, SOURCE);
  const hostDoc = host.join('main.tex');
  assert.equal(await ctl.edit('main.tex', { op: [{ p: 0, i: 'é' }], v: doc.v }), doc.v);
  await until(() => host.text('main.tex')?.startsWith('é'));
  await host.edit('main.tex', { op: [{ p: host.text('main.tex').length, i: '∑' }], v: hostDoc.v + 1 });
  assert.equal(host.text('main.tex'), 'é' + SOURCE + '∑');
  assert.deepEqual(host.participants().map(p => p.name), ['Ada 😀']);
  // The finder carried only offers, answers and ICE: no passcode, name, room key material or project content.
  const seen = JSON.stringify(taps);
  assert.ok(taps.length >= 3 && taps.every(([, , , m]) => ['offer', 'answer', 'ice', 'bye'].includes(m.t)));
  for (const secret of [host.passcode, host.passcode.replaceAll('-', ''), 'MARKER-SOURCE', 'Ada', 'Türkçe']) assert.ok(!seen.includes(secret), secret);
  ctl.leave(); await host.stop();
});

test('wrong passcode is refused and nothing is adopted; unknown room and missing finder fail with a clear reason', async () => {
  const { host, join, signaling } = await room();
  await assert.rejects(join('Eve', 'AAAA-AAAA-AAAA-AAAA'), /passcode|failed|answer/i);
  assert.equal(host.participants().length, 0);
  await assert.rejects(joinSession({ link: host.link.replace(/#room=.*/, '#room=' + 'B'.repeat(22)), passcode: host.passcode, username: 'Bo', P2PSocketImpl: p2pSocket({ signaling, RTC }), retries: [] }), /Nobody is sharing this room/);
  await assert.rejects(joinSession({ link: host.link, passcode: host.passcode, username: 'Bo', P2PSocketImpl: p2pSocket({ signaling: null, RTC }), retries: [] }), /no room finder/);
  await assert.rejects(startHost({ helper: p2pHelper({ signaling: null, RTC }), source: { tree: () => ({ files: [], docs: [], main: null }), text: () => null } }), /no room finder/);
  await host.stop();
});

test('a finder outage after joining leaves the session working; new joins wait until it is back', async () => {
  const { host, join, signaling, helper } = await room();
  const ctl = await join('Ada');
  signaling.outage(true);
  assert.equal(helper.state, 'down');
  const doc = await ctl.join('main.tex');
  assert.equal(await ctl.edit('main.tex', { op: [{ p: 0, i: 'x' }], v: doc.v }), doc.v);
  await assert.rejects(join('Bo'), /unreachable/);
  signaling.outage(false);
  assert.equal(helper.state, 'up');
  ctl.leave(); await host.stop();
});

test('hostile peers: malformed frames and oversized reassembly drop only that peer; a stalled peer is dropped at the queue limit', async () => {
  const { host, join, helper } = await room();
  const ctl = await join('Ada');
  const peers = () => helper.peers;
  const before = peers();
  // Ada's end of the channel sends a frame with an invalid piece header: the owner closes that connection only.
  const adaEnd = [...FakePC.all].find(p => !p.offerer && p.channel?.readyState === 'open')?.channel;
  adaEnd.send(Uint8Array.of(9, 9, 9).buffer);
  await until(() => peers() === before - 1 && host.participants().length === 0);
  // A frame that never ends: MORE pieces past MAX_MESSAGE (512 KiB) are refused before they are buffered further.
  const cy = await join('Cy');
  const cyEnd = [...FakePC.all].find(p => !p.offerer && p.channel?.readyState === 'open')?.channel, more = new Uint8Array(65535);
  for (let i = 0; i < 9; i++) cyEnd.send(more.buffer.slice(0));
  await until(() => host.participants().length === 0);
  void cy;
  // A peer that never drains: every send queues behind its buffer until QUEUE_LIMIT, then the owner drops it.
  const bo = await join('Bo');
  const boOwnerEnd = [...FakePC.all].find(p => p.channel && !p.offerer && p.channel.readyState === 'open')?.channel.other;
  boOwnerEnd.stall = true; boOwnerEnd.bufferedAmount = 2 * 1024 * 1024;
  const peer = host.participants()[0].peer;
  for (let sent = 0; sent <= QUEUE_LIMIT; sent += 400_000) helper.send({ op: 'send', peer, data: Buffer.alloc(400_000).toString('base64') });
  await until(() => host.participants().length === 0);
  bo.leave(); await host.stop();
});
