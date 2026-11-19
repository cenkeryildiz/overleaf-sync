// SPDX-License-Identifier: AGPL-3.0-only
(() => {
  if (new URLSearchParams(location.search).get('participant-compile') !== '1' || globalThis.overleafParticipantFetch) return;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.overleafParticipantFetch = original;
  const client = import('/participant/client.mjs');
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && /^\/project\/[a-f0-9]{24}\/compile\/stop$/.test(url.pathname) && init?.method === 'POST') {
      return (await client).cancel();
    }
    if (url.origin === location.origin && /^\/project\/[a-f0-9]{24}\/compile$/.test(url.pathname) && init?.method === 'POST') {
      // Only the editor's automatic compiles (on load, on change) may reuse an identical earlier result; Recompile always compiles.
      try { return await (await client).compile(init.signal, url.searchParams.get('auto_compile') === 'true'); }
      catch { return Response.json({ error: 'Participant compilation unavailable.' }, { status: 503 }); }
    }
    return original(input, init);
  };
})();
