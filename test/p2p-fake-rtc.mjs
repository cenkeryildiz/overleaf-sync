// SPDX-License-Identifier: AGPL-3.0-only
// Fake WebRTC for the stage 4 Node tests: messages over 64 KiB are rejected, as real stacks do past the negotiated limit.
/** Fake WebRTC: an offer's sdp names the offering connection; setRemoteDescription(answer) opens both channel ends. */
const offers = new Map(); let ids = 0;
export class FakeChannel {
  constructor(label) { Object.assign(this, { label, readyState: 'connecting', bufferedAmount: 0, other: null, sent: 0 }); }
  send(data) {
    if (this.readyState !== 'open') throw Error('not open');
    if (data.byteLength > 65536) throw Error('message too big'); // what real stacks do past the negotiated limit
    this.sent++;
    if (this.stall) { this.bufferedAmount += data.byteLength; return; }
    const copy = data.slice().buffer; setImmediate(() => this.other.readyState === 'open' && this.other.onmessage?.({ data: copy }));
  }
  close() { if (this.readyState === 'closed' || this.readyState === 'closing') return; this.readyState = 'closing'; setImmediate(() => this.#closed()); } // queued messages arrive first, as in real stacks
  #closed() { this.readyState = 'closed'; setImmediate(() => this.onclose?.()); const o = this.other; if (o && o.readyState !== 'closed') { o.readyState = 'closed'; setImmediate(() => o.onclose?.()); } }
}
export class FakePC {
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
    const mine = this.channel, theirs = new FakeChannel(mine.label); mine.other = theirs; theirs.other = mine; answerer.channel = theirs; // so closing the answering connection closes its end
    setImmediate(() => { answerer.ondatachannel?.({ channel: theirs }); setImmediate(() => { mine.readyState = theirs.readyState = 'open'; theirs.onopen?.(); mine.onopen?.(); }); });
  }
  async addIceCandidate(c) { this.ice = (this.ice ?? 0) + 1; if (!c?.candidate) throw Error('bad candidate'); }
  close() { this.connectionState = 'closed'; this.channel?.close(); }
}
FakePC.all = new Set();
export const RTC = class extends FakePC { constructor(c) { super(c); FakePC.all.add(this); } };

