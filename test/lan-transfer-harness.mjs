// SPDX-License-Identifier: AGPL-3.0-only
// In-memory room harness shared by the LAN transfer/store tests: an OwnerRoom wired to participants without any socket.
import { OwnerRoom, joinRoom } from '../runtime/chrome-extension/lan-room.mjs';

export const tick = () => new Promise(resolve => setImmediate(resolve));
export const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error('Timed out'); await tick(); } };
export const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

/** record:false keeps no copy of sealed frames (large-transfer measurements); join: factory taking joinRoom's arguments. */
export function harness({ record = true, join = joinRoom, ...events } = {}) {
  const links = new Map(), dropped = new Set(); let next = 1;
  const room = new OwnerRoom({
    send: (peer, bytes) => { const link = links.get(peer); if (link && !dropped.has(peer)) { if (record) link.toParticipant.push(bytes); setImmediate(() => link.session.receive(bytes)); } },
    admit: () => {},
    drop: peer => { dropped.add(peer); const link = links.get(peer); if (link) setImmediate(() => link.session.closed()); },
    ...events,
  });
  const connect = ({ passcode = room.passcode, username = 'Ada', ...rest } = {}) => {
    const peer = next++, link = { peer, toParticipant: [], toOwner: [] };
    links.set(peer, link); room.connected(peer);
    link.session = join({
      roomId: room.roomId, passcode, username,
      send: bytes => { if (record) link.toOwner.push(bytes); if (!dropped.has(peer)) setImmediate(() => room.receive(peer, bytes)); },
      close: () => { if (!dropped.has(peer)) { dropped.add(peer); room.disconnected(peer); } },
      ...rest,
    });
    return link;
  };
  return { room, connect, dropped, links };
}
