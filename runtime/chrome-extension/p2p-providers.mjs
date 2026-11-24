// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 external services (decided 24 November 2026; nothing here is operated or paid for by this project).
//
// ROOM FINDER: public MQTT brokers over secure WebSockets, all used at once so one outage does not stop rooms. They relay only
// AES-GCM ciphertext under a hashed topic (p2p-signal.mjs mqttSignaling): never the room ID, passcode, names or project content.
// They do see connecting IP addresses, message sizes and timing. Public test brokers promise no availability or retention.
// The manifest's connect-src must list exactly these hosts.
export const BROKERS = Object.freeze([
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
]);

// CONNECTION PATHS: a public STUN server finds each computer's public address; the free Open Relay TURN service relays the
// (DTLS-encrypted) data when no direct path exists, including over TLS on port 443 for networks that block other traffic
// (for example eduroam). Its username/password are published openly by the service for public use: they are not a secret and
// no account or billing exists, so no spending cap applies. Availability of the free tier is not verified; replace it here.
export const ICE_SERVERS = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
]);
