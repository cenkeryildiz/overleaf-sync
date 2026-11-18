// SPDX-License-Identifier: AGPL-3.0-only
// Upstream real-time checks the session only when a socket connects. Recheck it before every write and
// document read so logout, expiry or session revocation also stops sockets that are already open.
import assert from 'node:assert/strict';

const signed = `        metrics.inc('session.cookie', 1, { status: 'signed' })
        next(null, socket, session)`;
export function patchSessionSockets(source) {
  assert.equal(source.split(signed).length - 1, 1, 'Pinned session handshake differs');
  assert(!source.includes('olSessionStillValid'), 'Session recheck already installed');
  return source.replace(signed, `        metrics.inc('session.cookie', 1, { status: 'signed' })
        const identity = value => String(value?.passport?.user?._id ?? value?.user?._id ?? '')
        // Same cookie, same stored session and same account; anything else ends this socket.
        socket.olSessionStillValid = callback =>
          sessionStore.get(sessionId, (error, current) =>
            callback(error, Boolean(current) && identity(current) === identity(session)))
        next(null, socket, session)`);
}

const handleError = '  _handleError(callback, error, client, method, attrs) {';
const otCall = `        WebsocketController.applyOtUpdate(
          client,
          docId,
          update,
          function (err) {
            if (err) {
              Router._handleError(callback, err, client, 'applyOtUpdate', {
                doc_id: docId,
              })
            } else {
              callback()
            }
          }
        )`;
const joinCall = `        WebsocketController.joinDoc(
          client,
          docId,
          fromVersion,
          options,
          function (err, ...args) {
            if (err) {
              Router._handleError(callback, err, client, 'joinDoc', {
                doc_id: docId,
                fromVersion,
              })
            } else {
              callback(null, ...args)
            }
          }
        )`;
const indent = (text, by) => text.split('\n').map(line => line && by + line).join('\n');
export function patchRouter(source) {
  for (const anchor of [handleError, otCall, joinCall]) assert.equal(source.split(anchor).length - 1, 1, 'Pinned real-time router differs');
  assert(!source.includes('_requireLiveSession'), 'Session recheck already installed');
  return source
    .replace(handleError, `  _requireLiveSession(client, method, next) {
    // Fail closed. An ended session is disconnected without acknowledging the request, so the browser
    // keeps unsent edits; the existing connect-time check then asks for a new login before they resend.
    const ended = error => {
      logger.debug({ err: error, method, clientId: client.id }, 'session ended; disconnecting client')
      client.disconnect()
    }
    if (typeof client.olSessionStillValid !== 'function') return ended()
    client.olSessionStillValid((error, valid) => (error || !valid ? ended(error) : next()))
  },

` + handleError)
    .replace(otCall, `        Router._requireLiveSession(client, 'applyOtUpdate', () =>\n${indent(otCall, '  ')}\n        )`)
    .replace(joinCall, `        Router._requireLiveSession(client, 'joinDoc', () =>\n${indent(joinCall, '  ')}\n        )`);
}
export const anchors = Object.freeze({ signed, handleError, otCall, joinCall });
