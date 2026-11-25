// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 member identity: one ECDSA P-256 key pair per person per room, created with a non-extractable private key, so it can be
// kept (IndexedDB stores CryptoKey objects as they are) but never exported, logged or put into a project copy.
// The pair holds no names, roles or project data, so every member may keep it; it lets a member resume on any coordinator.
const subtle = globalThis.crypto.subtle;
export const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' }, SIGN = { name: 'ECDSA', hash: 'SHA-256' };
export const KEY = /^[A-Za-z0-9_-]{87}$/; // base64url of a 65-byte uncompressed P-256 point
export const b64u = bytes => { let t = ''; for (const b of bytes) t += String.fromCharCode(b); return btoa(t).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); };
export const unb64u = text => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

const imported = new Map();
async function publicKey(key) {
  if (!KEY.test(key)) throw Error('Invalid member key');
  let k = imported.get(key);
  if (!k) { k = await subtle.importKey('raw', unb64u(key), ALGORITHM, false, ['verify']); if (imported.size > 512) imported.clear(); imported.set(key, k); }
  return k;
}
/** True only for a valid signature by `key` over `bytes`; malformed keys or signatures are false, never an exception. */
export async function verify(key, signature, bytes) {
  try { return typeof signature === 'string' && signature.length <= 200 && await subtle.verify(SIGN, await publicKey(key), unb64u(signature), bytes); } catch { return false; }
}
/** An identity wraps its key pair: `key` is the public half (base64url), `sign(bytes)` the only use of the private half. */
export function wrap(pair, key) {
  return Object.freeze({ key, sign: async bytes => b64u(new Uint8Array(await subtle.sign(SIGN, pair.privateKey, bytes))) });
}
export async function newIdentity() {
  const pair = await subtle.generateKey(ALGORITHM, false, ['sign', 'verify']);
  return { pair, identity: wrap(pair, b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)))) };
}

/**
 * Keeps identities by room. `db` is an IndexedDB factory (default the browser's); `memory: true` keeps nothing on disk (tests,
 * restricted members). Only key pairs are stored: no names, roles or project data.
 */
export function identityStore({ db = globalThis.indexedDB, memory = !db } = {}) {
  const held = new Map();
  const open = () => new Promise((resolve, reject) => {
    const request = db.open('latex-p2p-identity', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pairs');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const run = async (mode, act) => { const conn = await open(); try { return await new Promise((resolve, reject) => { const tx = conn.transaction('pairs', mode), r = act(tx.objectStore('pairs')); tx.oncomplete = () => resolve(r?.result); tx.onabort = () => reject(tx.error || Error('Room identity storage transaction aborted')); }); } finally { conn.close(); } };
  return {
    /** The identity for this room: the stored one, else a new one (stored when `keep`). */
    async forRoom(roomId, { keep = true } = {}) {
      if (held.has(roomId)) return held.get(roomId);
      const pending = (async () => {
        if (memory || !keep) return (await newIdentity()).identity;
        let pair = await run('readonly', s => s.get(roomId));
        if (!pair) {
          const fresh = await newIdentity();
          try { await run('readwrite', s => s.add(fresh.pair, roomId)); return fresh.identity; }
          catch (error) {
            if (error?.name !== 'ConstraintError') throw error;
            pair = await run('readonly', s => s.get(roomId)); // another tab won; never overwrite its identity
          }
        }
        if (!pair?.privateKey || !pair?.publicKey) throw Error('Saved room identity is invalid; it was not replaced');
        return wrap(pair, b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))));
      })();
      held.set(roomId, pending);
      try { return await pending; }
      catch (error) { if (held.get(roomId) === pending) held.delete(roomId); throw error; }
    },
    async forget(roomId) { await held.get(roomId)?.catch(() => {}); held.delete(roomId); if (!memory) await run('readwrite', s => s.delete(roomId)).catch(() => {}); },
  };
}
