// SPDX-License-Identifier: AGPL-3.0-only
// Share panel (owner) and join form (participant) for the native workspace. Text only: names and messages are set with
// textContent, never as HTML; the passcode exists only in this panel and is never written to a URL, storage or log.
import { HELPER_HINT, helperAvailable, helperSocket, nativeHelper, startHost } from './lan-host.mjs';
import { joinSession, memoryProjects } from './lan-guest.mjs';
import { parseJoinLink } from './lan-room.mjs';

export const GRANT_LABELS = [['online', 'Edit while I’m online'], ['copy', 'Can keep a copy']];
export const el = (tag, props = {}, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
export const hueOf = name => [...new TextEncoder().encode(name)].reduce((h, b) => (h * 31 + b) % 360, 7);
export const style = el('style', { textContent: `
.lan-panel{--lan-bg:var(--olx-bg,#fff);--lan-fg:var(--olx-fg,#1b222c);--lan-muted:color-mix(in srgb,var(--lan-fg) 58%,transparent);--lan-line:color-mix(in srgb,var(--lan-fg) 12%,transparent);--lan-soft:color-mix(in srgb,var(--lan-fg) 5%,transparent);--lan-accent:#2f6fde;--lan-danger:#c4372e;
  position:fixed;top:52px;right:14px;z-index:6000;box-sizing:border-box;width:min(392px,calc(100vw - 28px));max-height:calc(100vh - 72px);overflow:auto;padding:18px 18px 16px;border:1px solid var(--lan-line);border-radius:14px;
  background:var(--lan-bg);color:var(--lan-fg);font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 24px 48px -16px rgba(16,24,40,.28),0 2px 6px rgba(16,24,40,.08);animation:lan-in .14s ease-out}
@keyframes lan-in{from{opacity:0;transform:translateY(-4px) scale(.99)}}
@media (prefers-reduced-motion:reduce){.lan-panel{animation:none}}
.lan-panel *{box-sizing:border-box}.lan-panel[hidden]{display:none}
.lan-head{display:flex;align-items:center;gap:8px;margin:0 0 14px}.lan-head h2{margin:0;font-size:15px;font-weight:650;letter-spacing:-.01em;flex:1}
.lan-live{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;background:color-mix(in srgb,#1f9d55 14%,transparent);color:#1f8a4c;font-size:11.5px;font-weight:600}
.lan-live::before{content:"";width:7px;height:7px;border-radius:50%;background:#1f9d55;box-shadow:0 0 0 3px color-mix(in srgb,#1f9d55 25%,transparent)}
.lan-x{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--lan-muted);font-size:16px;line-height:1;cursor:pointer}.lan-x:hover{background:var(--lan-soft);color:var(--lan-fg)}
.lan-step{display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;margin-bottom:14px}.lan-num{width:22px;height:22px;border-radius:50%;background:var(--lan-soft);color:var(--lan-muted);display:grid;place-items:center;font-size:11.5px;font-weight:650}
.lan-step p{margin:1px 0 8px;font-weight:550}.lan-row{display:flex;gap:8px;align-items:center}
.lan-panel code{display:block;min-width:0;flex:1;padding:8px 10px;border-radius:9px;background:var(--lan-soft);font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;user-select:all}
.lan-panel code.lan-pass{text-align:center;font-size:19px;font-weight:600;letter-spacing:.14em;padding:10px;white-space:normal}
.lan-btn{flex:none;height:32px;padding:0 12px;border:1px solid var(--lan-line);border-radius:9px;background:var(--lan-bg);color:var(--lan-fg);font:inherit;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s}
.lan-btn:hover{background:var(--lan-soft)}.lan-btn.lan-primary{background:var(--lan-accent);border-color:var(--lan-accent);color:#fff}.lan-btn.lan-primary:hover{filter:brightness(1.06)}
.lan-btn:focus-visible,.lan-x:focus-visible,.lan-panel select:focus-visible,.lan-panel input:focus-visible{outline:2px solid var(--lan-accent);outline-offset:2px}
.lan-hint{margin:4px 0 0;color:var(--lan-muted);font-size:12px}
.lan-section{margin:16px -18px 0;padding:14px 18px 0;border-top:1px solid var(--lan-line)}.lan-section h3{margin:0 0 8px;font-size:12px;font-weight:650;color:var(--lan-muted);text-transform:uppercase;letter-spacing:.06em}
.lan-panel ul{list-style:none;margin:0;padding:0}.lan-person{display:flex;align-items:center;gap:10px;padding:7px 0}.lan-person+.lan-person{border-top:1px solid var(--lan-line)}
.lan-avatar{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:650;font-size:12px}
.lan-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.lan-panel select{height:30px;max-width:150px;padding:0 6px;border:1px solid var(--lan-line);border-radius:8px;background:var(--lan-bg);color:var(--lan-fg);font:inherit}
.lan-remove{flex:none;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--lan-muted);font:inherit;cursor:pointer}.lan-remove:hover,.lan-remove.lan-confirm{background:color-mix(in srgb,var(--lan-danger) 10%,transparent);color:var(--lan-danger)}
.lan-empty{color:var(--lan-muted);padding:6px 0}
.lan-panel [role=status]{margin:10px 0 0;min-height:1.2em;color:var(--lan-muted);font-size:12px}.lan-panel [role=status]:empty{display:none}
.lan-stop{width:100%;margin-top:14px;height:34px;border:1px solid color-mix(in srgb,var(--lan-danger) 35%,transparent);border-radius:9px;background:transparent;color:var(--lan-danger);font:inherit;font-weight:600;cursor:pointer}.lan-stop:hover{background:color-mix(in srgb,var(--lan-danger) 8%,transparent)}
.lan-panel label{display:block;margin:12px 0 6px;font-weight:600}.lan-panel input{width:100%;height:38px;padding:0 12px;border:1px solid var(--lan-line);border-radius:9px;background:var(--lan-bg);color:var(--lan-fg);font:inherit}
.lan-panel input.lan-code{font:600 16px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}
.lan-join{position:fixed;inset:0;z-index:6500;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--olx-bg,#fff) 92%,#7a8599)}
.lan-join .lan-panel{position:static;width:min(380px,100%);padding:24px}.lan-join .lan-btn.lan-primary{width:100%;height:38px;margin-top:18px}
.lan-sub{margin:-8px 0 6px;color:var(--lan-muted)}` });
export const copyButton = (label, value) => {
  const button = el('button', { type: 'button', className: 'lan-btn lan-primary', textContent: label });
  button.onclick = async () => { try { await navigator.clipboard.writeText(value()); button.textContent = 'Copied ✓'; } catch { button.textContent = 'Select and copy'; } setTimeout(() => { button.textContent = label; }, 1600); };
  return button;
};

/** Owner: open the room, show link and passcode, list participants, stop on request. Resolves with the running host. */
export async function shareFlow({ source, events, helper = nativeHelper() }) {
  const link = el('code'), pass = el('code', { className: 'lan-pass' }), people = el('ul'), note = el('p', { role: 'status' }), count = el('span');
  const close = el('button', { type: 'button', className: 'lan-x', textContent: '✕', ariaLabel: 'Close', title: 'Close (Esc)' });
  const stopButton = el('button', { type: 'button', className: 'lan-stop', textContent: 'Stop sharing' });
  const panel = el('section', { className: 'lan-panel', role: 'dialog', ariaLabel: 'Share on this network' },
    el('div', { className: 'lan-head' }, el('h2', { textContent: 'Share on this network' }), el('span', { className: 'lan-live', textContent: 'Live' }), close),
    el('div', { className: 'lan-step' }, el('span', { className: 'lan-num', textContent: '1' }), el('div', {}, el('p', { textContent: 'Send this link' }),
      el('div', { className: 'lan-row' }, link, copyButton('Copy link', () => link.textContent)))),
    el('div', { className: 'lan-step' }, el('span', { className: 'lan-num', textContent: '2' }), el('div', {}, el('p', { textContent: 'Tell them this code separately' }),
      el('div', { className: 'lan-row' }, pass, copyButton('Copy code', () => pass.textContent)), el('p', { className: 'lan-hint', textContent: 'Not in the same message as the link. Anyone with both can edit while sharing is on.' }))),
    el('div', { className: 'lan-section' }, el('h3', {}, 'In this session', count), people,
      el('p', { className: 'lan-hint', textContent: 'Edit while I’m online: nothing is saved on their device. Can keep a copy: they may save and export their own copy; switching back stops new copies, not earlier ones.' })),
    note, stopButton);
  document.head.append(style); document.body.append(panel);
  let host;
  // One row per participant: session name as text plus the owner's choice. The room enforces it (lan-grants.mjs), not this select.
  const render = names => {
    const list = host ? host.participants() : names.map(name => ({ name }));
    count.textContent = list.length ? ` · ${list.length}` : '';
    if (!list.length) { people.replaceChildren(el('li', { className: 'lan-empty', textContent: 'Nobody has joined yet' })); return; }
    people.replaceChildren(...list.map(({ peer, name, grant }) => {
      const avatar = el('span', { className: 'lan-avatar', textContent: [...name][0]?.toUpperCase() ?? '?' }); avatar.style.background = `hsl(${hueOf(name)} 55% 46%)`;
      if (!peer) return el('li', { className: 'lan-person' }, avatar, el('span', { className: 'lan-name', textContent: name }));
      const choice = el('select', { ariaLabel: `Permission for ${name}` }, ...GRANT_LABELS.map(([value, label]) => el('option', { value, textContent: label })));
      choice.value = grant;
      choice.onchange = async () => {
        choice.disabled = true;
        try { await host.setGrant(peer, choice.value); note.textContent = choice.value === 'copy' ? `${name} may now save, export and download a copy.` : `${name} can no longer make copies. Copies already made are not recalled.`; }
        catch { choice.value = host.participants().find(p => p.peer === peer)?.grant ?? 'online'; note.textContent = `${name} is no longer in the session.`; }
        finally { choice.disabled = false; }
      };
      const remove = el('button', { type: 'button', className: 'lan-remove', textContent: 'Remove', ariaLabel: `Remove ${name}` }); let armed;
      const disarm = () => { armed = undefined; remove.textContent = 'Remove'; remove.ariaLabel = `Remove ${name}`; remove.classList.remove('lan-confirm'); };
      remove.onclick = async () => {
        if (!armed) { armed = setTimeout(disarm, 3000); remove.textContent = 'Confirm'; remove.ariaLabel = `Confirm: remove ${name}`; remove.classList.add('lan-confirm'); return; }
        clearTimeout(armed); remove.disabled = true;
        try { pass.textContent = await host.remove(peer); note.textContent = `${name} was removed. New joins need the new code above; people still here are not affected.`; }
        catch { note.textContent = `${name} could not be removed. Stop sharing to end every session.`; }
        render([]); stopButton.focus(); // the row and its button are gone: keep keyboard focus inside the panel
      };
      return el('li', { className: 'lan-person' }, avatar, el('span', { className: 'lan-name', textContent: name, title: name }), choice, remove);
    }));
  };
  // Light dismiss: a click anywhere outside the panel (except the Share button, which toggles it) or Esc hides it.
  const share = () => document.querySelector('#local-share');
  const outside = event => { if (!panel.hidden && !panel.contains(event.target) && !share()?.contains(event.target)) panel.hidden = true; };
  const escape = event => { if (event.key === 'Escape' && !panel.hidden) { panel.hidden = true; share()?.focus(); } };
  document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape);
  const gone = () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape); panel.remove(); events.onStopped?.(); };
  try {
    host = await startHost({
      helper, source, onRemote: (...a) => events.onRemote?.(...a), onCursor: (...a) => events.onCursor?.(...a), onLost: gone,
      onPeers: names => { render(names); events.onPeers?.(names); }, onPool: info => events.onPool?.(info),
      permission: info => events.permission?.(info) !== false,
      network: !globalThis.LATEX_LAN_LOOPBACK, // the loopback browser fixture sets this; real use shares on the local network
    });
  } catch (error) { gone(); helper.close(); throw error; }
  link.textContent = host.link; link.title = host.link; pass.textContent = host.passcode; render([]); panel.querySelector('.lan-btn').focus();
  close.onclick = () => { panel.hidden = true; };
  stopButton.onclick = async () => { stopButton.disabled = true; await host.stop(); gone(); };
  host.panel = panel;
  return host;
}

/** Participant: ask for the link, passcode and a session name, join, and resolve with the in-memory project API. */
export function joinForm(hash, events) {
  document.head.append(style);
  const initial = hash ? `chrome-extension://${location.host}/extension/index.html#${hash}` : '';
  const link = el('input', { id: 'lan-join-link', value: initial, ariaLabel: 'Join link', autocomplete: 'off', spellcheck: false });
  const code = el('input', { id: 'lan-join-code', ariaLabel: 'Passcode', className: 'lan-code', autocomplete: 'off', spellcheck: false, placeholder: 'XXXX-XXXX-XXXX-XXXX', autofocus: true });
  const name = el('input', { id: 'lan-join-name', ariaLabel: 'Your name for this session', autocomplete: 'off', maxLength: 32, placeholder: 'How others will see you' });
  const note = el('p', { role: 'status' }), submit = el('button', { type: 'submit', className: 'lan-btn lan-primary', textContent: 'Join' });
  let from = ''; try { const t = parseJoinLink(initial); from = t.p2p ? 'Shared over the internet.' : `Shared from ${t.host} on your network.`; } catch {}
  // The link opened this page, so only the passcode and a name are asked; without a valid link the field is shown.
  const form = el('form', { className: 'lan-panel', ariaLabel: 'Join a shared project' }, el('div', { className: 'lan-head' }, el('h2', { textContent: 'Join a shared project' })),
    ...(from ? [el('p', { className: 'lan-sub', textContent: from })] : [el('label', { textContent: 'Join link', htmlFor: link.id }), link]),
    el('label', { textContent: 'Passcode', htmlFor: code.id }), code, el('label', { textContent: 'Your name for this session', htmlFor: name.id }), name, submit, note);
  const screen = el('div', { className: 'lan-join' }, form); document.body.append(screen); code.focus();
  return new Promise(resolve => {
    form.onsubmit = async event => {
      event.preventDefault(); submit.disabled = true; submit.textContent = 'Connecting…'; note.textContent = '';
      const passcode = code.value; code.value = '';
      // The helper connects when installed: Chrome's local-network rules block extension pages from reaching another computer,
      // and they change by version. Without it, try the browser's own WebSocket (older browsers, same computer).
      let internet = false; try { internet = !!parseJoinLink(link.value.trim()).p2p; } catch {}
      const viaHelper = !internet && await helperAvailable(); // internet rooms use WebRTC: no helper
      try {
        if (internet) {
          const { joinInternet } = await import('./p2p-ui.mjs');
          const joined = await joinInternet({ link: link.value.trim(), passcode, username: name.value, events,
            offerReopen: () => new Promise(resolve => { note.textContent = 'Nobody is online. A permitted copy of this room is saved here.';
              const reopen = el('button', { type: 'button', className: 'lan-btn', textContent: 'Reopen saved room', onclick: () => { reopen.remove(); cancel.remove(); resolve(true); } });
              const cancel = el('button', { type: 'button', className: 'lan-btn', textContent: 'Cancel', onclick: () => { reopen.remove(); cancel.remove(); resolve(false); } }); note.append(reopen, cancel); }) });
          screen.remove(); resolve(joined); return;
        }
        const shared = await joinSession({ link: link.value.trim(), passcode, username: name.value, onRemote: (...a) => events.onRemote?.(...a),
          onCursor: (...a) => events.onCursor?.(...a), onFs: op => events.onFs?.(op), onGrant: g => events.onGrant?.(g), onPresence: n => events.onPeers?.(n), onEnd: reason => { events.onEnd?.(reason); },
          onLost: (...a) => events.onLost?.(...a), onResumed: c => events.onResumed?.(c), onGroup: m => events.onGroup?.(m), WebSocketImpl: viaHelper ? helperSocket() : globalThis.WebSocket });
        const template = await (await fetch('/extension/native-template.json')).json();
        const { api, project, docIds } = await memoryProjects(shared, template);
        screen.remove(); resolve({ api, shared, project, docIds });
      } catch (error) { note.textContent = error.message.includes(HELPER_HINT) || viaHelper || internet ? error.message : `${error.message} ${HELPER_HINT}`; submit.disabled = false; submit.textContent = 'Join'; }
    };
  });
}
