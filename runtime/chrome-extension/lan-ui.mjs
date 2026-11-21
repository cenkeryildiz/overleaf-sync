// SPDX-License-Identifier: AGPL-3.0-only
// Share panel (owner) and join form (participant) for the native workspace. Text only: names and messages are set with
// textContent, never as HTML; the passcode exists only in this panel and is never written to a URL, storage or log.
import { nativeHelper, startHost } from './lan-host.mjs';
import { joinSession, memoryProjects } from './lan-guest.mjs';

const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
const style = el('style', { textContent: `.lan-panel{position:fixed;top:48px;right:12px;z-index:6000;width:min(420px,calc(100vw - 24px));padding:14px;border:1px solid var(--olx-line,#b4bac5);border-radius:8px;background:var(--olx-bg,#fff);color:var(--olx-fg,#1b222c);font:13px/1.4 system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.2)}
.lan-panel h2{margin:0 0 8px;font-size:15px}.lan-panel label{display:block;margin-top:8px;font-weight:600}.lan-panel input{box-sizing:border-box;width:100%;padding:6px;font:inherit}
.lan-panel code{display:block;padding:6px;margin-top:2px;background:var(--olx-bg-2,#f4f5f6);word-break:break-all;font-size:14px;user-select:all}.lan-panel ul{margin:4px 0;padding-left:18px}.lan-panel button{margin:8px 8px 0 0;padding:6px 10px;font:inherit}
.lan-panel [role=status]{margin-top:8px;min-height:1.2em}.lan-join{position:fixed;inset:0;z-index:6500;display:grid;place-items:center;background:var(--olx-bg,#fff)}.lan-join .lan-panel{position:static}` });

/** Owner: open the room, show link and passcode, list participants, stop on request. Resolves with the running host. */
export async function shareFlow({ source, events, helper = nativeHelper() }) {
  const link = el('code'), pass = el('code'), people = el('ul'), note = el('p', { role: 'status' });
  const close = el('button', { type: 'button', textContent: 'Hide' }), stopButton = el('button', { type: 'button', textContent: 'Stop sharing' });
  const panel = el('section', { className: 'lan-panel', role: 'dialog', ariaLabel: 'Share on this network' }, el('h2', { textContent: 'Share on this network' }),
    el('p', { textContent: 'Send the link and the passcode separately. Anyone with both can edit this project while sharing is on, until you stop sharing.' }),
    el('label', { textContent: 'Join link' }), link, el('label', { textContent: 'Passcode' }), pass, el('label', { textContent: 'Participants' }), people, note, close, stopButton);
  document.head.append(style); document.body.append(panel);
  let host;
  const gone = () => { panel.remove(); events.onStopped?.(); };
  try {
    host = await startHost({
      helper, source, onRemote: (...a) => events.onRemote?.(...a), onCursor: (...a) => events.onCursor?.(...a), onLost: gone,
      onPeers: names => { people.replaceChildren(...(names.length ? names : ['Nobody has joined yet']).map(name => el('li', { textContent: name }))); events.onPeers?.(names); },
      permission: info => events.permission?.(info) !== false,
    });
  } catch (error) { panel.remove(); helper.close(); throw error; }
  link.textContent = host.link; pass.textContent = host.passcode; people.replaceChildren(el('li', { textContent: 'Nobody has joined yet' }));
  close.onclick = () => { panel.hidden = true; };
  stopButton.onclick = async () => { stopButton.disabled = true; await host.stop(); gone(); };
  host.panel = panel;
  return host;
}

/** Participant: ask for the link, passcode and a session name, join, and resolve with the in-memory project API. */
export function joinForm(hash, events) {
  document.head.append(style);
  const initial = hash ? `chrome-extension://${location.host}/extension/index.html#${hash}` : '';
  const link = el('input', { value: initial, ariaLabel: 'Join link', autocomplete: 'off', spellcheck: false }), code = el('input', { ariaLabel: 'Passcode', autocomplete: 'off', spellcheck: false, placeholder: 'XXXX-XXXX-XXXX-XXXX' }), name = el('input', { ariaLabel: 'Your name for this session', autocomplete: 'off', maxLength: 32 });
  const note = el('p', { role: 'status' }), submit = el('button', { type: 'submit', textContent: 'Join' });
  const form = el('form', { className: 'lan-panel' }, el('h2', { textContent: 'Join a shared project' }), el('label', { textContent: 'Join link' }), link,
    el('label', { textContent: 'Passcode' }), code, el('label', { textContent: 'Your name for this session' }), name, submit, note);
  const screen = el('div', { className: 'lan-join' }, form); document.body.append(screen);
  return new Promise(resolve => {
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; note.textContent = 'Connecting...';
      const passcode = code.value; code.value = '';
      try {
        const shared = await joinSession({ link: link.value.trim(), passcode, username: name.value, onRemote: (...a) => events.onRemote?.(...a),
          onCursor: (...a) => events.onCursor?.(...a), onFs: op => events.onFs?.(op), onGrant: g => events.onGrant?.(g), onPresence: n => events.onPeers?.(n), onEnd: reason => { events.onEnd?.(reason); } });
        const template = await (await fetch('/extension/native-template.json')).json();
        const { api, project, docIds } = await memoryProjects(shared, template);
        screen.remove(); resolve({ api, shared, project, docIds });
      } catch (error) { note.textContent = error.message; submit.disabled = false; }
    };
  });
}
