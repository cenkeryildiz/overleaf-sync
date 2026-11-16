// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  const recovery = globalThis.overleafRecovery;
  if (!recovery || new URLSearchParams(location.search).get('participant-compile') !== '1') return;
  globalThis.overleafRecovery = Object.freeze({ ...recovery, attach(facade, container, name) {
    recovery.attach(facade, container, name);
    globalThis.overleafParticipantEditor = { facade, docId: container.doc_id };
  } });
})();
