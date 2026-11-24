// SPDX-License-Identifier: AGPL-3.0-only
// TEX-PKG-01: verify TeX Live's detached OpenPGP signature (v4, RSA) on texlive.tlpdb.sha512 with Web Crypto, against keys
// from the texlive.asc shipped in the app. Only what TeX Live uses is supported; anything else is refused.
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
export function dearmor(armored) {
  const m = armored.replace(/\r/g, '').match(/-----BEGIN PGP [A-Z ]+-----\n(?:[^\n]+\n)*?\n([\s\S]*?)\n(?:=[^\n]*\n)?-----END PGP /);   // the =CRC line is optional
  if (!m) throw Error('Not an armored OpenPGP block');
  return b64(m[1].replace(/\s+/g, ''));
}
function* packets(bytes) {
  let at = 0;
  while (at < bytes.length) {
    const head = bytes[at++]; if (!(head & 0x80)) throw Error('Corrupt OpenPGP packet');
    let tag, length;
    if (head & 0x40) { tag = head & 0x3f; const o = bytes[at++]; if (o < 192) length = o; else if (o < 224) length = ((o - 192) << 8) + bytes[at++] + 192; else if (o === 255) { length = new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0); at += 4; } else throw Error('Partial OpenPGP lengths are not supported'); }
    else { tag = (head >> 2) & 0x0f; const n = [1, 2, 4][head & 3]; if (!n) throw Error('Indeterminate OpenPGP length'); length = 0; for (let i = 0; i < n; i++) length = length * 256 + bytes[at++]; }
    if (at + length > bytes.length) throw Error('Truncated OpenPGP packet');
    yield { tag, body: bytes.subarray(at, at + length) }; at += length;
  }
}
const mpi = (bytes, at) => { const bits = (bytes[at] << 8) | bytes[at + 1], n = Math.ceil(bits / 8); return [bytes.subarray(at + 2, at + 2 + n), at + 2 + n]; };
/** RSA keys (primary and subkeys) of an armored public key block: [{fingerprint, n, e}]. */
export async function rsaKeys(armored) {
  const keys = [];
  for (const { tag, body } of packets(dearmor(armored))) {
    if ((tag !== 6 && tag !== 14) || body[0] !== 4 || ![1, 3].includes(body[5])) continue;
    const [n, at] = mpi(body, 6), [e] = mpi(body, at);
    const framed = new Uint8Array(3 + body.length); framed.set([0x99, body.length >> 8, body.length & 255]); framed.set(body, 3);
    keys.push({ fingerprint: hex(new Uint8Array(await crypto.subtle.digest('SHA-1', framed))), n, e });
  }
  return keys;
}
/** True only when `signatureArmored` is a valid v4 RSA signature over `message` (string) by one of `keys`. */
export async function verifyDetached(message, signatureArmored, keys) {
  const [sig] = [...packets(dearmor(signatureArmored))].filter(p => p.tag === 2).map(p => p.body);
  if (!sig || sig[0] !== 4) throw Error('Unsupported signature version');
  const type = sig[1], algo = sig[2], hashId = sig[3], hashedLength = (sig[4] << 8) | sig[5];
  const hash = { 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512' }[hashId]; if (!hash || ![1, 3].includes(algo) || ![0, 1].includes(type)) throw Error('Unsupported signature algorithm');
  const hashedEnd = 6 + hashedLength, unhashedLength = (sig[hashedEnd] << 8) | sig[hashedEnd + 1], after = hashedEnd + 2 + unhashedLength;
  let issuer = null;   // issuer fingerprint (33) or key ID (16) subpacket, hashed or not
  for (const [from, to] of [[6, hashedEnd], [hashedEnd + 2, after]]) for (let at = from; at < to;) {
    let len = sig[at++]; if (len >= 192 && len < 255) len = ((len - 192) << 8) + sig[at++] + 192; else if (len === 255) { len = new DataView(sig.buffer, sig.byteOffset + at, 4).getUint32(0); at += 4; }
    const kind = sig[at] & 0x7f, data = sig.subarray(at + 1, at + len); at += len;
    if (kind === 33 && data[0] === 4) issuer = hex(data.subarray(1)); else if (kind === 16 && !issuer) issuer = hex(data);
  }
  const key = keys.find(k => issuer && k.fingerprint.endsWith(issuer)); if (!key) return false;
  const [value] = mpi(sig, after + 2), size = key.n.length, signature = new Uint8Array(size); if (value.length > size) return false; signature.set(value, size - value.length);
  const text = type === 1 ? new TextEncoder().encode(message.replace(/\r?\n/g, '\r\n')) : new TextEncoder().encode(message);   // type 1: canonical text
  const trailer = new Uint8Array(6); trailer.set([4, 0xff]); new DataView(trailer.buffer).setUint32(2, hashedEnd);
  const data = new Uint8Array(text.length + hashedEnd + 6); data.set(text); data.set(sig.subarray(0, hashedEnd), text.length); data.set(trailer, text.length + hashedEnd);
  const cryptoKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: b64url(key.n), e: b64url(key.e), alg: { 'SHA-256': 'RS256', 'SHA-384': 'RS384', 'SHA-512': 'RS512' }[hash], ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
}
