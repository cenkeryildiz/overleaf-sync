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

// CONNECTION PATHS: STUN discovers candidate public addresses. TURN remains unconfigured: Open Relay's current documented
// JavaScript flow requires an account/API-issued iceServers list. Do not ship legacy shared credentials or a private API key.
// Restrictive networks may therefore have no connection path until an approved, scoped TURN credential mechanism exists.
export const ICE_SERVERS = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
]);
