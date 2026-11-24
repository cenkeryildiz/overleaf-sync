// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4 internet room UI for the native workspace: the share choice, the room panel (short link, passcode, members and the
// owner's controls), the ownership-offer banner, "Save for offline" and the internet branch of the join form. Text only (textContent);
// the passcode lives in this panel and the room's memory, never in a URL, storage or log. Decisions here are the project's (24 Nov).
import { el, style, copyButton, hueOf, GRANT_LABELS } from './lan-ui.mjs';
import { memoryProjects } from './lan-guest.mjs';
import { createInternetRoom, joinInternetRoom, reopenInternetRoom } from './p2p-room.mjs';

const extra = el('style', { textContent: `
.lan-choice{display:grid;gap:8px;margin-top:4px}.lan-choice .lan-btn{height:auto;padding:10px 12px;text-align:left;font-weight:550}.lan-choice .lan-btn b{display:block;font-weight:650}
.lan-choice .lan-btn span{display:block;color:var(--lan-muted);font-weight:450;font-size:12px}
.lan-badge{flex:none;padding:1px 7px;border-radius:999px;background:var(--lan-soft);color:var(--lan-muted);font-size:11px;font-weight:600}
.lan-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--lan-line)}.lan-dot.on{background:#1f9d55}
.lan-more{flex:none;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--lan-muted);font:inherit;cursor:pointer}.lan-more:hover{background:var(--lan-soft);color:var(--lan-fg)}
.lan-menu{display:flex;flex-wrap:wrap;gap:6px;padding:4px 0 8px 38px}.lan-offer{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:6100;width:min(420px,calc(100vw - 28px))}
.lan-panel .lan-actions{display:flex;gap:8px;margin-top:14px}.lan-panel .lan-actions>*{flex:1}` });
const mount = () => { document.head.append(style, extra); };

/** Owner's first click on Share: on this network (stage 2) or over the internet. Resolves 'lan', {mode:'internet', name} or null. */
export function shareChoice() {
  mount();
  return new Promise(resolve => {
    const name = el('input', { id: 'p2p-owner-name', ariaLabel: 'Your name in the room', maxLength: 32, placeholder: 'How others will see you', value: 'Owner' });
    const close = el('button', { type: 'button', className: 'lan-x', textContent: '✕', ariaLabel: 'Close', title: 'Close (Esc)' });
    const pick = (value, title, detail) => { const b = el('button', { type: 'button', className: 'lan-btn' }, el('b', { textContent: title }), el('span', { textContent: detail })); b.onclick = () => done(value === 'internet' ? { mode: 'internet', name: name.value } : 'lan'); return b; };
    const panel = el('section', { className: 'lan-panel', role: 'dialog', ariaLabel: 'Share' }, el('div', { className: 'lan-head' }, el('h2', { textContent: 'Share' }), close),
      el('div', { className: 'lan-choice' }, pick('lan', 'On this network', 'People on the same Wi-Fi or office network.'),
        pick('internet', 'Over the internet', 'People anywhere. No server: computers connect directly; anyone online keeps the room going.')),
      el('label', { textContent: 'Your name (internet rooms)', htmlFor: name.id }), name);
    const escape = event => { if (event.key === 'Escape') done(null); };
    const done = value => { document.removeEventListener('keydown', escape); panel.remove(); resolve(value); };
    close.onclick = () => done(null); document.addEventListener('keydown', escape);
    document.body.append(panel); panel.querySelector('.lan-btn').focus();
  });
}

/**
 * The room panel, for the creator and for members (Share button). Lists members from the signed member list with who is online;
 * the owner changes roles, names a backup, offers ownership and removes members. Every change is signed and re-verified by every
 * computer: the controls only start it.
 */
export function roomPanel(room, { onClose = () => {} } = {}) {
  mount();
  const short = link => `…${link.slice(link.indexOf('#'))}`; // S6-03: a fixed-width panel shows the end of the link; Copy copies all of it
  const link = el('code', { title: room.link, textContent: short(room.link) }), pass = el('code', { className: 'lan-pass' }), people = el('ul'), note = el('p', { role: 'status' });
  const state = el('p', { className: 'lan-hint' }), count = el('span');
  const close = el('button', { type: 'button', className: 'lan-x', textContent: '✕', ariaLabel: 'Close', title: 'Close (Esc)' });
  const save = el('button', { type: 'button', className: 'lan-btn', textContent: 'Save for offline' });
  const leave = el('button', { type: 'button', className: 'lan-btn', textContent: 'Leave' });
  const end = el('button', { type: 'button', className: 'lan-stop', textContent: 'End the room for everyone' });
  const passStep = el('div', { className: 'lan-step' }, el('span', { className: 'lan-num', textContent: '2' }), el('div', {}, el('p', { textContent: 'Tell them this code separately' }),
    el('div', { className: 'lan-row' }, pass, copyButton('Copy code', () => room.passcode)), el('p', { className: 'lan-hint', textContent: 'Not in the same message as the link. The room finder never sees it.' })));
  const panel = el('section', { className: 'lan-panel', role: 'dialog', ariaLabel: 'Internet room' },
    el('div', { className: 'lan-head' }, el('h2', { textContent: 'Internet room' }), el('span', { className: 'lan-live', textContent: 'Live' }), close),
    el('div', { className: 'lan-step' }, el('span', { className: 'lan-num', textContent: '1' }), el('div', {}, el('p', { textContent: 'Send this link' }),
      el('div', { className: 'lan-row' }, link, copyButton('Copy link', () => room.link)))),
    passStep, state,
    el('div', { className: 'lan-section' }, el('h3', {}, 'Members', count), people,
      el('p', { className: 'lan-hint', textContent: 'Edit while online: nothing is kept on their computer. Can keep a copy: they may save a copy and continue the room when nobody else is online. A removed member keeps any copy already saved.' })),
    note, el('div', { className: 'lan-actions' }, save, leave), end);
  const online = () => new Set([...(room.host?.participants() ?? []).map(p => p.name), ...(room.ctl ? [] : [])]);
  const say = text => { note.textContent = text; };
  const act = async (task, done) => { try { await task(); if (done) say(done); } catch (error) { say(error.message); } render(); };
  const render = () => {
    const members = room.members, owner = members.find(m => m.key === room.me) && room.owner, here = online();
    pass.textContent = room.passcode ?? ''; passStep.hidden = !room.passcode;
    count.textContent = ` · ${members.length}`;
    state.textContent = `${room.role === 'coordinator' ? 'This computer coordinates the room now.' : 'Another member’s computer coordinates the room.'}${room.frozen ? ' Permission changes are frozen: two different member lists exist.' : ''}`;
    save.hidden = members.find(m => m.key === room.me)?.role !== 'copy'; end.hidden = !owner;
    people.replaceChildren(...members.map(m => {
      const avatar = el('span', { className: 'lan-avatar', textContent: [...m.name][0]?.toUpperCase() ?? '?' }); avatar.style.background = `hsl(${hueOf(m.name)} 55% 46%)`;
      const badges = [m.key === room.ownerKey ? el('span', { className: 'lan-badge', textContent: 'Owner' }) : null,
        m.key === room.me ? el('span', { className: 'lan-badge', textContent: 'You' }) : null].filter(Boolean);
      const row = el('li', { className: 'lan-person' }, el('span', { className: 'lan-dot' + (here.has(m.name) || m.key === room.me ? ' on' : ''), title: here.has(m.name) ? 'Online' : '' }), avatar,
        el('span', { className: 'lan-name', textContent: m.name, title: m.name }), ...badges);
      if (!owner || m.key === room.me) return row;
      const choice = el('select', { ariaLabel: `Permission for ${m.name}` }, ...GRANT_LABELS.map(([value, label]) => el('option', { value, textContent: value === 'online' ? 'Edit while online' : label })));
      choice.value = m.role; choice.onchange = () => act(() => room.setRole(m.key, choice.value), `${m.name}: ${choice.value === 'copy' ? 'may keep a copy' : 'edits while online only'}.`);
      const more = el('button', { type: 'button', className: 'lan-more', textContent: '⋯', ariaLabel: `More for ${m.name}`, ariaExpanded: 'false' });
      const menu = el('div', { className: 'lan-menu', hidden: true },
        button('Make backup owner', () => act(() => room.setBackup(m.key), `${m.name} can claim ownership if your key is lost.`)),
        button('Offer ownership', () => act(() => room.offerTransfer(m.key), `Ownership offered to ${m.name}; it moves when they accept.`)),
        confirmButton(`Remove ${m.name}`, () => act(() => room.remove(m.key), `${m.name} was removed and the passcode changed. Copies they saved earlier remain theirs.`)));
      more.onclick = () => { menu.hidden = !menu.hidden; more.ariaExpanded = String(!menu.hidden); };
      row.append(choice, more);
      return el('div', {}, row, menu);
    }));
  };
  save.onclick = () => act(() => room.saveForReopen((project, meta) => shelf.put(meta.roomId, { project, room: meta })), 'Saved on this computer: you can reopen this room when nobody else is online.');
  leave.onclick = () => act(async () => { await room.leave(); panel.remove(); onClose('left'); });
  end.onclick = () => act(async () => { await room.endRoom(); panel.remove(); onClose('ended'); });
  close.onclick = () => { panel.hidden = true; };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) panel.hidden = true; });
  document.body.append(panel); render();
  return { panel, render, say };
}
const button = (label, onclick) => el('button', { type: 'button', className: 'lan-btn', textContent: label, onclick });
function confirmButton(label, onclick) {
  const b = button(label, () => { if (b.dataset.armed) { onclick(); return; } b.dataset.armed = '1'; b.textContent = 'Confirm: ' + label.toLowerCase(); b.classList.add('lan-confirm'); setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 3000); });
  b.className = 'lan-remove'; return b;
}

/** A transfer offer arrived: accept (sign) or decline; nothing changes until accepted. */
export function offerBanner(room, offer) {
  mount();
  const box = el('div', { className: 'lan-panel lan-offer', role: 'alertdialog', ariaLabel: 'Ownership offer' }, el('p', { textContent: 'The owner offers you ownership of this room. You would manage members and permissions.' }));
  const yes = button('Accept ownership', async () => { try { await room.acceptTransfer(offer); box.remove(); } catch (error) { box.firstChild.textContent = error.message; } });
  yes.classList.add('lan-primary');
  box.append(el('div', { className: 'lan-actions' }, yes, button('Decline', () => box.remove())));
  document.body.append(box); yes.focus();
}

/** Owner: create the internet room for the open project; returns the host the workspace drives, with the panel attached. */
export async function internetShare({ source, events, name }) {
  const panelEvents = {};
  const room = await createInternetRoom({ source, username: name, events: { ...events, onMembers: () => panelEvents.render?.(), onPeers: names => { events.onPeers?.(names); panelEvents.render?.(); } } });
  const ui = roomPanel(room, { onClose: () => events.onStopped?.() }); panelEvents.render = ui.render;
  return Object.assign(room.host, { panel: ui.panel, internetRoom: room });
}

// ---- saved rooms (copy members only; written only after the owner's persist ticket, through saveForReopen) ----------------------
export const shelf = {
  open: () => new Promise((resolve, reject) => { const r = indexedDB.open('latex-p2p-rooms', 1); r.onupgradeneeded = () => r.result.createObjectStore('rooms'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }),
  async run(mode, act) { const db = await this.open(); try { return await new Promise((resolve, reject) => { const tx = db.transaction('rooms', mode), r = act(tx.objectStore('rooms')); tx.oncomplete = () => resolve(r?.result); tx.onerror = () => reject(tx.error); }); } finally { db.close(); } },
  put(roomId, value) { return this.run('readwrite', s => s.put(value, roomId)); },
  get(roomId) { return this.run('readonly', s => s.get(roomId)).catch(() => null); },
};

/**
 * Join form, internet branch: join by link + passcode; with nobody online, offer to reopen from this computer's saved copy.
 * Resolves like the LAN join ({api, shared, project, docIds}) plus `room`.
 */
export async function joinInternet({ link, passcode, username, events, offerReopen }) {
  const panelEvents = {};
  const wrapped = { ...events,
    ...Object.fromEntries(['onRemote', 'onCursor', 'onFs', 'onGrant', 'onPeers', 'onResumed', 'onEnd'].map(name => [name, (...args) => events[name]?.(...args)])),
    onLost: (reason, info) => events.onLost?.(reason, { ...info, continueHere: info.reopen ? () => room.continueHere() : undefined }),
    onTransferOffer: offer => offerBanner(room, offer), onMembers: () => panelEvents.render?.(),
    onRole: role => { events.onRole?.(role); panelEvents.render?.(); }, onRemoved: () => events.onEnd?.('The owner removed you from this room'),
    onFork: paths => events.onFork?.(paths) };
  let room;
  try { room = await joinInternetRoom({ link, passcode, username, events: wrapped }); }
  catch (error) {
    if (error.code !== 'nobody') throw error;
    const saved = await shelf.get(/#room=([A-Za-z0-9_-]{22})$/.exec(link)?.[1]);
    if (!saved || !await offerReopen()) throw error;
    room = await reopenInternetRoom({ saved, passcode, events: wrapped });
  }
  const template = await (await fetch('/extension/native-template.json')).json();
  const { api, project, docIds } = await memoryProjects(room.ctl, template);
  room.showPanel = () => { if (!room.panelUi) { room.panelUi = roomPanel(room); panelEvents.render = room.panelUi.render; } else { room.panelUi.panel.hidden = !room.panelUi.panel.hidden; room.panelUi.render(); } };
  return { api, shared: room.ctl, project, docIds, room };
}
