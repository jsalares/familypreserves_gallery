// Family Preserves customer gallery: sort copies into custom folders, add
// details, tag people, turn photos, mark photos to restore.
//
// Every edit shows on screen at once and is queued as a "change" (see
// server/changes.js). The queue sends changes in the background and retries
// until they're saved; step 3 adds keeping the queue on the device too.

const slug = location.pathname.split('/')[2];
const api = (p) => `/api/g/${encodeURIComponent(slug)}${p}`;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const ICON = {
  check: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  x: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  folder: (s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/></svg>`,
  lock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
  trash: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
  left: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`,
  rotL: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4M4 9h5"/><path d="M4.6 9A8 8 0 1 1 4 13"/></svg>`,
  rotR: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 9V4M20 9h-5"/><path d="M19.4 9A8 8 0 1 0 20 13"/></svg>`,
  right: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
  chevron: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
};

// -------------------------------------------------------------------- state

const S = {
  order: null,
  sources: [], // [{ name, count }]
  custom: [], // custom folder names, in order
  people: [], // every person the customer has added
  maxCustom: 8,
  photos: [],
  view: { kind: 'all' }, // all | source | folder
  onlyUnfiled: false,
  mode: 'photo', // photo | grid
  sort: 'scan',
  openId: null,
  keepId: null, // a just-filed photo that stays on screen until the customer moves on
  barOpen: true,
  confirmDelete: false,
  zoom: null, // { id, side } when one side of a two-sided photo is shown on its own
  folderDraft: '',
};

const byId = new Map();
const inFolder = (p, name) => p.customFolders.includes(name);

function visiblePhotos() {
  const v = S.view;
  let list = S.photos.filter((p) => {
    if (v.kind === 'source' && p.folder !== v.name) return false;
    if (v.kind === 'folder' && !inFolder(p, v.name)) return false;
    if (S.onlyUnfiled && v.kind !== 'folder' && p.customFolders.length > 0 && !(p.id === S.keepId && p.id === S.openId)) return false;
    return true;
  });
  const year = (p) => {
    const m = /\d{4}/.exec(p.year);
    return m ? Number(m[0]) : null;
  };
  if (S.sort === 'old' || S.sort === 'new') {
    const dir = S.sort === 'old' ? 1 : -1;
    list = list
      .map((p, i) => ({ p, i, y: year(p) }))
      .sort((a, b) => (a.y === null) - (b.y === null) || (a.y - b.y) * dir || a.i - b.i)
      .map((x) => x.p);
  } else if (S.sort === 'place') {
    list = list
      .map((p, i) => ({ p, i }))
      .sort((a, b) => !a.p.place - !b.p.place || collator.compare(a.p.place, b.p.place) || a.i - b.i)
      .map((x) => x.p);
  }
  return list;
}

function viewTitle() {
  const v = S.view;
  let t = v.kind === 'all' ? 'All photos' : v.kind === 'source' ? `${v.name} (scanned folder)` : v.name;
  if (S.onlyUnfiled && v.kind !== 'folder') t += ', not in a custom folder';
  return t;
}

// ------------------------------------------------------------ saving changes
//
// Every change is written to this device (localStorage) before it is sent,
// and only forgotten once the server has it. Closing the tab, losing signal
// or a flat battery just means the changes go up on the next visit. Each
// change states an end result, so sending one twice is harmless.

const device = {
  key: `fpg-pending:${slug}`,
  ok: true, // false if this browser won't let us store anything
  save(list) {
    try {
      if (list.length) localStorage.setItem(this.key, JSON.stringify(list));
      else localStorage.removeItem(this.key);
      this.ok = true;
    } catch {
      this.ok = false;
    }
  },
  read() {
    try {
      const list = JSON.parse(localStorage.getItem(this.key) || '[]');
      return Array.isArray(list) ? list.filter((x) => x && x.change && typeof x.change.op === 'string') : [];
    } catch {
      return [];
    }
  },
};

const saver = {
  queue: [], // [{ key, change }] not yet sent
  inflight: [], // sent, waiting for the server's answer
  failures: 0,
  timer: null,
  lastError: '',

  persist() {
    device.save([...this.inflight, ...this.queue]);
  },

  add(change, key, delay = 400) {
    if (key) {
      // Newest value wins. It moves to the end, so it still follows any
      // folder change made before it.
      const i = this.queue.findIndex((q) => q.key === key);
      if (i >= 0) this.queue.splice(i, 1);
    }
    this.queue.push({ key, change });
    this.persist();
    this.later(delay);
    renderSaveStatus();
  },

  later(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  },

  async flush({ keepalive = false } = {}) {
    if (this.inflight.length || this.queue.length === 0) return;
    this.inflight = this.queue.splice(0, 100);
    renderSaveStatus();
    try {
      const res = await fetch(api('/changes'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changes: this.inflight.map((b) => b.change) }),
        keepalive,
      });
      if (res.status === 401) {
        this.queue.unshift(...this.inflight);
        this.inflight = [];
        this.lastError = 'You were signed out. Sign in again to keep saving. Your changes are kept on this device.';
        renderSaveStatus();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { results } = await res.json();
      const refused = results.filter((r) => !r.ok);
      this.inflight = [];
      this.persist();
      this.failures = 0;
      this.lastError = '';
      if (refused.length) {
        // The server said no (for example a ninth folder): show why and reload
        // so the screen matches what was actually saved.
        showNotice(refused[0].error);
        await load({ keepPlace: true });
      }
    } catch {
      this.queue.unshift(...this.inflight); // keep order; try again shortly
      this.inflight = [];
      this.failures += 1;
      this.later(Math.min(30000, 1000 * 2 ** this.failures));
    }
    renderSaveStatus();
    if (this.queue.length && !this.failures) this.later(50);
  },

  pending() {
    return this.queue.length + this.inflight.length;
  },
};

window.addEventListener('online', () => {
  saver.failures = 0;
  saver.later(0);
});
// Leaving or hiding the page: send what we can right away.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saver.flush({ keepalive: true });
});
window.addEventListener('beforeunload', (e) => {
  // Changes are safe on this device, so only warn if it can't store them.
  if (saver.pending() && !device.ok) {
    saver.flush({ keepalive: true });
    e.preventDefault();
    e.returnValue = '';
  }
});

// --------------------------------------------------- applying changes locally

// Applies a change to the screen's copy of the gallery, the same way the
// server does. Used for every edit, for undo, and to put back changes that
// were still waiting on this device from an earlier visit.
function applyLocal(c) {
  const photo = c.photoId != null ? byId.get(Number(c.photoId)) : null;
  switch (c.op) {
    case 'folder.create':
      if (!S.custom.includes(c.name)) S.custom.push(c.name);
      return;
    case 'folder.delete':
      S.custom = S.custom.filter((f) => f !== c.name);
      for (const p of S.photos) p.customFolders = p.customFolders.filter((f) => f !== c.name);
      if (S.view.kind === 'folder' && S.view.name === c.name) S.view = { kind: 'all' };
      return;
    case 'photo.folder':
      if (!photo) return;
      if (c.on) {
        if (!S.custom.includes(c.name)) S.custom.push(c.name);
        if (!photo.customFolders.includes(c.name)) {
          photo.customFolders = S.custom.filter((f) => f === c.name || photo.customFolders.includes(f));
        }
      } else {
        photo.customFolders = photo.customFolders.filter((f) => f !== c.name);
      }
      return;
    case 'photo.person':
      if (!photo) return;
      if (c.on) {
        if (!S.people.includes(c.name)) S.people = [...S.people, c.name].sort(collator.compare);
        if (!photo.people.includes(c.name)) photo.people = [...photo.people, c.name].sort(collator.compare);
      } else {
        photo.people = photo.people.filter((n) => n !== c.name);
      }
      return;
    case 'photo.field':
      if (photo) photo[c.field] = c.value;
      return;
    case 'photo.enhance':
      if (photo) photo.enhance = Boolean(c.on);
      return;
    case 'photo.rotate': {
      const target = c.side === 'back' ? photo?.back : photo;
      if (target) target.rotation = c.degrees;
      return;
    }
  }
}

// The change(s) that would put things back the way they are right now.
function inverseOf(c) {
  const photo = c.photoId != null ? byId.get(Number(c.photoId)) : null;
  switch (c.op) {
    case 'folder.create':
      return S.custom.includes(c.name) ? [] : [{ op: 'folder.delete', name: c.name }];
    case 'folder.delete':
      if (!S.custom.includes(c.name)) return [];
      return [
        { op: 'folder.create', name: c.name },
        ...S.photos.filter((p) => inFolder(p, c.name)).map((p) => ({ op: 'photo.folder', photoId: p.id, name: c.name, on: true })),
      ];
    case 'photo.folder':
      if (!photo) return [];
      return [
        ...(S.custom.includes(c.name) ? [] : [{ op: 'folder.delete', name: c.name }]),
        { ...c, on: inFolder(photo, c.name) },
      ].reverse();
    case 'photo.person':
      return photo ? [{ ...c, on: photo.people.includes(c.name) }] : [];
    case 'photo.field':
      return photo ? [{ ...c, value: photo[c.field] || '' }] : [];
    case 'photo.enhance':
      return photo ? [{ ...c, on: photo.enhance }] : [];
    case 'photo.rotate': {
      const target = c.side === 'back' ? photo?.back : photo;
      return target ? [{ ...c, degrees: target.rotation }] : [];
    }
    default:
      return [];
  }
}

// Changes to the same thing replace each other in the queue.
function changeKey(c) {
  switch (c.op) {
    case 'photo.folder': return `f:${c.photoId}:${c.name}`;
    case 'photo.person': return `p:${c.photoId}:${c.name}`;
    case 'photo.field': return `t:${c.photoId}:${c.field}`;
    case 'photo.enhance': return `e:${c.photoId}`;
    case 'photo.rotate': return `r:${c.photoId}:${c.side}`;
    default: return undefined; // folder create/delete keep their order
  }
}

const undoStack = []; // [{ label, changes, merge }]
const UNDO_LIMIT = 50;

// Makes an edit: shows it now, keeps it on the device, sends it, and
// remembers how to undo it. Edits with the same `merge` in a row (typing in
// one box) undo together.
function act(label, changes, { merge = null, delay } = {}) {
  const inverse = [];
  for (const c of changes) {
    inverse.unshift(...inverseOf(c));
    applyLocal(c);
    saver.add(c, changeKey(c), delay);
  }
  const top = undoStack[undoStack.length - 1];
  if (merge && top && top.merge === merge) return renderUndo();
  if (inverse.length) {
    undoStack.push({ label, changes: inverse, merge });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }
  renderUndo();
}

function undo() {
  const entry = undoStack.pop();
  if (!entry) return;
  for (const c of entry.changes) {
    applyLocal(c);
    saver.add(c, changeKey(c), 200);
  }
  showNotice(`Undone: ${entry.label}`);
  render();
  renderUndo();
}

function renderUndo() {
  const btn = $('undo');
  const top = undoStack[undoStack.length - 1];
  btn.hidden = !top;
  if (top) {
    btn.title = `Undo: ${top.label}`;
    btn.setAttribute('aria-label', `Undo: ${top.label}`);
  }
}

function renderSaveStatus() {
  const el = $('save-status');
  const n = saver.pending();
  let state = 'saved';
  let text = `${ICON.check(16)} All changes saved`;
  if (saver.lastError) {
    state = 'error';
    text = esc(saver.lastError);
  } else if (n && (saver.failures || !navigator.onLine)) {
    state = 'offline';
    text = device.ok
      ? `Offline · ${plural(n, 'change', 'changes')} kept on this device`
      : `Not connected · ${plural(n, 'change', 'changes')} waiting to save`;
  } else if (n) {
    state = 'saving';
    text = `Saving… ${n} waiting`;
  }
  el.dataset.state = state;
  el.innerHTML = text;
}

function showNotice(message) {
  const n = $('notice');
  n.textContent = message;
  n.hidden = false;
  clearTimeout(showNotice.t);
  showNotice.t = setTimeout(() => (n.hidden = true), 8000);
}

// ---------------------------------------------------------------- actions

function toggleFolder(photo, name) {
  const on = !inFolder(photo, name);
  // With "only show photos not in a custom folder" on, the photo stays on
  // screen after it is filed, so it can go in more than one folder. It drops
  // out of the list once the customer moves to another photo.
  if (on && S.mode === 'photo') {
    S.openId = photo.id;
    S.keepId = photo.id;
  }
  act(on ? `copy to ${name}` : `remove from ${name}`, [{ op: 'photo.folder', photoId: photo.id, name, on }]);
}

function stepFrom(photo, dir) {
  const list = visiblePhotos();
  const i = list.findIndex((p) => p.id === photo.id);
  const next = list[i + dir] || list[i - dir];
  S.openId = next && next.id !== photo.id ? next.id : null;
}

function addFolder(rawName) {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (S.custom.some((f) => f.toLowerCase() === name.toLowerCase())) return showNotice(`You already have a folder called ${name}.`);
  if (S.custom.length >= S.maxCustom) return showNotice(`You can have up to ${S.maxCustom} custom folders.`);
  S.folderDraft = '';
  act(`add folder ${name}`, [{ op: 'folder.create', name }]);
}

function deleteFolder(name) {
  S.view = { kind: 'all' };
  S.confirmDelete = false;
  act(`delete folder ${name}`, [{ op: 'folder.delete', name }]);
}

function togglePerson(photo, name) {
  const on = !photo.people.includes(name);
  act(on ? `tag ${name}` : `untag ${name}`, [{ op: 'photo.person', photoId: photo.id, name, on }]);
}

function addPerson(photo, rawName) {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const existing = S.people.find((n) => n.toLowerCase() === name.toLowerCase());
  const final = existing || name;
  if (!photo.people.includes(final)) togglePerson(photo, final);
}

function setField(photo, field, value) {
  act(`edit ${field}`, [{ op: 'photo.field', photoId: photo.id, field, value }], { merge: `t:${photo.id}:${field}`, delay: 900 });
}

function rotate(photo, side, dir) {
  const target = side === 'back' ? photo.back : photo;
  if (!target) return;
  act(`turn the ${side}`, [{ op: 'photo.rotate', photoId: photo.id, side, degrees: (target.rotation + dir + 360) % 360 }]);
}

function toggleEnhance(photo) {
  act(photo.enhance ? 'untick Restore' : 'tick Restore', [{ op: 'photo.enhance', photoId: photo.id, on: !photo.enhance }]);
}

// --------------------------------------------------------------- rendering

function chip(cls, act, label, count, pressed, extra = '') {
  return `<button type="button" class="chip ${cls}" data-act="${act}" ${extra} aria-pressed="${pressed}">${esc(label)} <span class="n">${count}</span></button>`;
}

function renderShelves() {
  const filed = S.photos.filter((p) => p.customFolders.length).length;
  const unfiled = S.photos.length - filed;
  const pct = S.photos.length ? Math.round((filed / S.photos.length) * 100) : 0;
  const v = S.view;
  let html = `<div class="shelves-inner">
    <div class="shelves-head">
      <button type="button" class="toggle-bar" data-act="toggle-bar" aria-expanded="${S.barOpen}" aria-controls="shelf-body">
        ${ICON.chevron} ${S.barOpen ? 'Hide folders' : `Folders · showing ${esc(viewTitle())}`}
      </button>
      <span class="progress">${filed} of ${S.photos.length} in a custom folder
        <span class="progress-bar"><span id="progress-fill"></span></span></span>
    </div>`;
  if (S.barOpen) {
    html += `<div id="shelf-body" class="shelves-inner shelf-body">
      <div class="shelf" role="group" aria-label="Scanned folders">
        <span class="shelf-label">Scanned folders</span>
        ${chip('chip-source', 'view-all', 'All', S.photos.length, v.kind === 'all')}
        ${S.sources
          .map((f) => chip('chip-source', 'view-source', f.name, f.count, v.kind === 'source' && v.name === f.name, `data-name="${esc(f.name)}"`))
          .join('')}
        <button type="button" class="switch" role="switch" data-act="only-unfiled" aria-checked="${S.onlyUnfiled}">
          <span class="switch-track"></span> Only show photos not in a custom folder <span class="left">(${unfiled} left)</span>
        </button>
      </div>
      <div class="shelf" role="group" aria-label="Your custom folders">
        <span class="shelf-label">Your custom folders</span>
        ${S.custom
          .map((name) =>
            chip('chip-custom', 'view-folder', name, S.photos.filter((p) => inFolder(p, name)).length, v.kind === 'folder' && v.name === name, `data-name="${esc(name)}"`)
          )
          .join('')}
        ${
          S.custom.length < S.maxCustom
            ? `<form class="add-folder" data-form="add-folder">
                <input type="text" name="name" aria-label="New folder name" placeholder="New folder name" maxlength="40" value="${esc(S.folderDraft)}">
                <button type="submit">Add folder</button>
              </form>`
            : `<span class="hint">${S.maxCustom} folders is the limit. Delete one to add another.</span>`
        }
      </div>
    </div>`;
  }
  $('shelves').innerHTML = html + '</div>';
  // Set through the DOM because the page's security policy blocks style attributes.
  $('progress-fill').style.width = `${pct}%`;
}

function renderBanner() {
  const v = S.view;
  if (v.kind === 'source') {
    return `<section class="banner banner-original" aria-label="You are viewing a scanned folder">
      ${ICON.folder()}
      <div class="banner-text">
        <span class="kicker">${ICON.lock} Scanned folder · as we received them</span>
        <span class="name serif">${esc(v.name)}</span>
        <span class="sub">These photos stay here permanently. Copy them into your custom folders and add details as you go.</span>
      </div>
    </section>`;
  }
  if (v.kind === 'folder') {
    const n = S.photos.filter((p) => inFolder(p, v.name)).length;
    const actions = S.confirmDelete
      ? `<span class="q" role="alert">Delete “${esc(v.name)}” and its ${plural(n, 'copy', 'copies')}? The photos stay in your scanned folders.</span>
         <button type="button" class="btn-light" data-act="delete-folder">Yes, delete</button>
         <button type="button" class="btn-outline-light" data-act="cancel-delete">Cancel</button>`
      : `<button type="button" class="btn-outline-light" data-act="ask-delete">${ICON.trash} Delete this folder</button>`;
    return `<section class="banner banner-custom" aria-label="You are viewing one of your custom folders">
      ${ICON.folder()}
      <div class="banner-text">
        <span class="kicker">Custom folder · copies</span>
        <span class="name serif">${esc(v.name)}</span>
        <span class="sub">Removing a photo here only removes this copy. It stays in its scanned folder.</span>
      </div>
      <div class="banner-actions">${actions}</div>
    </section>`;
  }
  return '';
}

function summary(p) {
  const bits = [p.year, p.place, p.people.length === 1 ? p.people[0] : p.people.length ? `${p.people.length} people` : ''].filter(Boolean);
  return bits.length ? bits.join(' · ') : 'Tap to add details';
}

function renderGrid(list) {
  const removeFrom = S.view.kind === 'folder' ? S.view.name : null;
  return `<div class="photo-grid">${list
    .map(
      (p) => `<figure class="tile">
        <button type="button" class="tile-img" data-act="open" data-id="${p.id}" aria-label="Open ${esc(p.filename)}">
          <img src="${esc(p.thumb)}" alt="" loading="lazy" decoding="async" class="r${p.rotation}">
          ${p.back ? '<span class="badge badge-left">Front &amp; back</span>' : ''}
          ${p.enhance ? '<span class="badge">Restore</span>' : ''}
        </button>
        ${removeFrom ? `<button type="button" class="pill pill-remove" data-act="remove-here" data-id="${p.id}">${ICON.x} Remove from ${esc(removeFrom)}</button>` : ''}
        <figcaption>
          <div class="summary">${esc(summary(p))}</div>
          <div class="pills" role="group" aria-label="Copy ${esc(p.filename)} to a custom folder">
            ${S.custom
              .map((f) => {
                const on = inFolder(p, f);
                return `<button type="button" class="pill" data-act="toggle-folder" data-id="${p.id}" data-name="${esc(f)}" aria-pressed="${on}">${on ? ICON.check(12) : ''}${esc(f)}</button>`;
              })
              .join('')}
          </div>
        </figcaption>
      </figure>`
    )
    .join('')}</div>`;
}

// The big photo. A photo with a back shows both sides next to each other;
// tapping one shows it on its own, tapping again goes back to both.
function renderStage(p) {
  const sides = [{ side: 'front', label: 'Front', src: p.screen, rot: p.rotation }];
  if (p.back) sides.push({ side: 'back', label: 'Back', src: p.back.screen, rot: p.back.rotation });
  const zoom = p.back && S.zoom?.id === p.id ? S.zoom.side : null;
  const shown = zoom ? sides.filter((x) => x.side === zoom) : sides;
  const alt = (x) => `${p.back ? `${x.label} of ` : ''}${p.caption || p.filename}`;
  const img = (x) => `<img src="${esc(x.src)}" alt="${esc(alt(x))}" class="r${x.rot}">`;
  const frame = shown
    .map((x) =>
      p.back
        ? `<button type="button" class="side" data-act="zoom-side" data-id="${p.id}" data-side="${x.side}" aria-label="${zoom ? 'Show both sides' : `Look closer at the ${x.label.toLowerCase()}`}">
            ${img(x)}<span class="side-label">${x.label}</span></button>`
        : `<div class="side">${img(x)}</div>`
    )
    .join('');
  const turn = (x) => `<span class="rotate-group">${p.back ? `<span class="rotate-label">${x.label}</span>` : ''}
      <button type="button" class="round" data-act="rotate" data-id="${p.id}" data-side="${x.side}" data-dir="-90" aria-label="Turn the ${x.label.toLowerCase()} left">${ICON.rotL}</button>
      <button type="button" class="round" data-act="rotate" data-id="${p.id}" data-side="${x.side}" data-dir="90" aria-label="Turn the ${x.label.toLowerCase()} right">${ICON.rotR}</button>
    </span>`;
  return `<div class="stage-frame${shown.length > 1 ? ' two' : ''}${zoom ? ' zoomed' : ''}">${frame}</div>
    <div class="rotate-bar">${shown.map(turn).join('')}
      ${zoom ? `<button type="button" class="pill" data-act="zoom-side" data-id="${p.id}" data-side="${zoom}">Show both sides</button>` : ''}
    </div>`;
}

function renderViewer(list) {
  let i = list.findIndex((p) => p.id === S.openId);
  if (i < 0) i = 0;
  const p = list[i];
  S.openId = p.id;
  const enhancedCount = S.photos.filter((x) => x.enhance).length;
  const where = p.customFolders.length
    ? `Edits here apply to this photo in ${p.folder} and its copies in ${p.customFolders.join(', ')}.`
    : `Edits here apply to this photo in ${p.folder}, and any copies you make later.`;
  const removeFrom = S.view.kind === 'folder' ? S.view.name : null;

  return `<div class="viewer-nav">
      <span>${esc(p.filename)} · Scanned folder: <strong>${esc(p.folder)}</strong></span>
      <span class="arrows">${i + 1} of ${list.length}
        <button type="button" class="round" data-act="prev" aria-label="Previous photo">${ICON.left}</button>
        <button type="button" class="round primary" data-act="next" aria-label="Next photo">${ICON.right}</button>
      </span>
    </div>
    <div class="viewer">
      <div class="stage">
        ${renderStage(p)}
      </div>
      <aside class="panel" data-photo="${p.id}">
        ${removeFrom ? `<button type="button" class="remove-here" data-act="remove-here" data-id="${p.id}">${ICON.x} Remove from ${esc(removeFrom)}</button>` : ''}
        <section>
          <h3>Copy to custom folders</h3>
          ${
            S.custom.length
              ? `<div class="boxes">${S.custom
                  .map((f) => {
                    const on = inFolder(p, f);
                    return `<button type="button" class="box" data-act="toggle-folder" data-id="${p.id}" data-name="${esc(f)}" aria-pressed="${on}">
                      <span class="tick">${on ? ICON.check(12) : ''}</span><span class="label">${esc(f)}</span></button>`;
                  })
                  .join('')}</div>`
              : '<p class="note">Add a custom folder above to start sorting.</p>'
          }
        </section>
        <section>
          <h3>Photo details</h3>
          <p class="note">${esc(where)}</p>
          <div class="fields">
            <label class="field">Year<input type="text" data-field="year" maxlength="20" placeholder="1978 or 1970s" value="${esc(p.year)}"></label>
            <label class="field">Place<input type="text" data-field="place" maxlength="100" placeholder="The cottage" value="${esc(p.place)}"></label>
            <label class="field wide">Event<input type="text" data-field="event" maxlength="100" placeholder="Christmas morning, Dad's 40th…" value="${esc(p.event)}"></label>
            <div class="field wide">People
              <div class="people">
                ${S.people
                  .map((n) => {
                    const on = p.people.includes(n);
                    return `<button type="button" class="person" data-act="toggle-person" data-id="${p.id}" data-name="${esc(n)}" aria-pressed="${on}">${on ? ICON.check(14) : ICON.plus}${esc(n)}</button>`;
                  })
                  .join('')}
                <form class="new-person" data-form="add-person" data-id="${p.id}">
                  <input type="text" name="name" aria-label="Add a new person" placeholder="New person" maxlength="40">
                  <button type="submit">Add</button>
                </form>
              </div>
            </div>
            <label class="field wide">Caption<textarea data-field="caption" rows="3" maxlength="1000" placeholder="What's happening in this photo?">${esc(p.caption)}</textarea></label>
          </div>
        </section>
        <button type="button" class="enhance" data-act="enhance" data-id="${p.id}" aria-pressed="${p.enhance}">
          <span class="tick">${p.enhance ? ICON.check(18) : ''}</span>
          <span class="enhance-text">
            <span class="t serif">Restore this photo</span>
            <span class="d">Repair of tears, creases, stains, fading and missing pieces. We'll send you a quote before doing any work.</span>
            <span class="c">${plural(enhancedCount, 'photo', 'photos')} marked for restoration so far</span>
          </span>
        </button>
      </aside>
    </div>
    <nav class="filmstrip" aria-label="Photos in this view">
      ${list
        .map(
          (x) => `<button type="button" data-act="open" data-id="${x.id}" aria-label="Go to ${esc(x.filename)}${x.customFolders.length ? ' (in a custom folder)' : ''}" aria-current="${x.id === p.id}">
            <img src="${esc(x.thumb)}" alt="" loading="lazy" decoding="async" class="r${x.rotation}">
            ${x.customFolders.length ? `<span class="filed">${ICON.check(10)}</span>` : ''}
          </button>`
        )
        .join('')}
    </nav>`;
}

function renderMain() {
  const list = visiblePhotos();
  const empty =
    S.onlyUnfiled && S.view.kind !== 'folder'
      ? 'Every photo here has a copy in one of your custom folders. Nice work!'
      : S.view.kind === 'folder'
        ? 'No photos in this folder yet. Tick it beside a photo to add one.'
        : 'No photos here yet.';
  $('main').innerHTML = `${renderBanner()}
    <div class="toolbar">
      <h2>${esc(viewTitle())} · ${list.length}</h2>
      <div class="toolbar-right">
        <div class="segmented" role="group" aria-label="View">
          <button type="button" data-act="mode-photo" aria-pressed="${S.mode === 'photo'}">One at a time</button>
          <button type="button" data-act="mode-grid" aria-pressed="${S.mode === 'grid'}">Grid</button>
        </div>
        <label class="sort">Sort by
          <select data-act="sort">
            <option value="scan"${S.sort === 'scan' ? ' selected' : ''}>Scan order</option>
            <option value="old"${S.sort === 'old' ? ' selected' : ''}>Year, oldest first</option>
            <option value="new"${S.sort === 'new' ? ' selected' : ''}>Year, newest first</option>
            <option value="place"${S.sort === 'place' ? ' selected' : ''}>Place, A to Z</option>
          </select>
        </label>
      </div>
    </div>
    ${list.length === 0 ? `<p class="empty">${empty}</p>` : S.mode === 'photo' ? renderViewer(list) : renderGrid(list)}`;
}

// Which control has focus, as a selector that finds its twin after a re-render.
function focusKey() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const d = el.dataset || {};
  if (d.field) return `[data-field="${d.field}"]`;
  if (!d.act) return null;
  let sel = `[data-act="${d.act}"]`;
  if (d.id) sel += `[data-id="${d.id}"]`;
  if (d.name) sel += `[data-name="${CSS.escape(d.name)}"]`;
  if (d.side) sel += `[data-side="${d.side}"]`;
  if (d.dir) sel += `[data-dir="${d.dir}"]`;
  return sel;
}

let lastOpenId = null;

// Re-draws the screen without moving the page: the filmstrip keeps its
// sideways scroll, focus stays on the same control, and only a change of
// photo slides the filmstrip (never the page) to the current thumbnail.
function render() {
  const strip = document.querySelector('.filmstrip');
  const stripLeft = strip ? strip.scrollLeft : 0;
  const key = focusKey();
  renderShelves();
  renderMain();
  renderSaveStatus();
  const newStrip = document.querySelector('.filmstrip');
  if (newStrip) {
    newStrip.scrollLeft = stripLeft;
    const current = newStrip.querySelector('[aria-current="true"]');
    if (current && S.openId !== lastOpenId) {
      newStrip.scrollLeft = current.offsetLeft - (newStrip.clientWidth - current.offsetWidth) / 2;
    }
  }
  lastOpenId = S.mode === 'photo' ? S.openId : null;
  if (key) document.querySelector(key)?.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ events

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.tagName === 'SELECT') return;
  const photo = t.dataset.id ? byId.get(Number(t.dataset.id)) : null;
  const name = t.dataset.name;
  const go = (view) => {
    S.view = view;
    S.openId = null;
    S.confirmDelete = false;
  };
  switch (t.dataset.act) {
    case 'toggle-bar': S.barOpen = !S.barOpen; break;
    case 'view-all': go({ kind: 'all' }); break;
    case 'view-source': go({ kind: 'source', name }); break;
    case 'view-folder': go({ kind: 'folder', name }); break;
    case 'only-unfiled': S.onlyUnfiled = !S.onlyUnfiled; S.openId = null; break;
    case 'mode-photo': S.mode = 'photo'; break;
    case 'mode-grid': S.mode = 'grid'; break;
    case 'open':
      // From the grid, jump up to the big photo. From the filmstrip, stay put.
      if (S.mode === 'grid') window.scrollTo({ top: $('main').offsetTop - 80 });
      S.openId = photo.id;
      S.mode = 'photo';
      break;
    case 'prev': case 'next': move(t.dataset.act === 'next' ? 1 : -1); return;
    case 'toggle-folder': toggleFolder(photo, name); break;
    case 'remove-here': if (S.mode === 'photo') stepFrom(photo, 1); toggleFolder(photo, S.view.name); break;
    case 'toggle-person': togglePerson(photo, name); break;
    case 'enhance': toggleEnhance(photo); break;
    case 'zoom-side': S.zoom = S.zoom?.id === photo.id ? null : { id: photo.id, side: t.dataset.side }; break;
    case 'rotate': rotate(photo, t.dataset.side, Number(t.dataset.dir)); break;
    case 'ask-delete': S.confirmDelete = true; break;
    case 'cancel-delete': S.confirmDelete = false; break;
    case 'delete-folder': deleteFolder(S.view.name); break;
    default: return;
  }
  render();
});

function move(dir) {
  const list = visiblePhotos();
  if (!list.length) return;
  let i = list.findIndex((p) => p.id === S.openId);
  if (i < 0) i = 0;
  S.openId = list[(i + dir + list.length) % list.length].id;
  render();
}

document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-act="sort"]')) {
    S.sort = e.target.value;
    S.openId = null;
    render();
  }
});

// Typing in a detail box saves quietly without redrawing the screen.
document.addEventListener('input', (e) => {
  const field = e.target.dataset.field;
  if (field) {
    const photo = byId.get(Number(e.target.closest('[data-photo]').dataset.photo));
    setField(photo, field, e.target.value);
  } else if (e.target.closest('[data-form="add-folder"]')) {
    S.folderDraft = e.target.value;
  }
});

// Leaving a detail box redraws so summaries and sorting pick up the change.
document.addEventListener('focusout', (e) => {
  if (e.target.dataset.field && !e.relatedTarget?.closest('[data-photo]')) renderShelves();
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const value = form.elements.name.value;
  if (form.dataset.form === 'add-folder') addFolder(value);
  if (form.dataset.form === 'add-person') addPerson(byId.get(Number(form.dataset.id)), value);
  render();
  const again = document.querySelector(`[data-form="${form.dataset.form}"] input`);
  if (again) again.focus({ preventScroll: true });
});

document.addEventListener('keydown', (e) => {
  // Ctrl+Z / Cmd+Z undoes the last edit, except while typing in a box
  // (there the browser's own undo is more useful).
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    undo();
    return;
  }
  if (S.mode !== 'photo' || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'ArrowRight') move(1);
  if (e.key === 'ArrowLeft') move(-1);
});

// Help popup
function setHelp(open) {
  $('help-pop').hidden = !open;
  $('help-btn').setAttribute('aria-expanded', String(open));
}
$('help-btn').addEventListener('click', () => setHelp($('help-pop').hidden));
$('undo').addEventListener('click', undo);
$('help-close').addEventListener('click', () => setHelp(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && setHelp(false));

$('signout').addEventListener('click', async () => {
  if (saver.pending()) await saver.flush();
  await fetch(api('/sign-out'), { method: 'POST' });
  location.reload();
});

// ------------------------------------------------------------------- start

let firstLoad = true;

async function load({ keepPlace = false } = {}) {
  const res = await fetch(api('/gallery'));
  if (res.status === 401) return location.reload();
  if (!res.ok) {
    $('main').innerHTML = '<p class="status">We couldn\'t load your photos. Please refresh the page to try again.</p>';
    return;
  }
  const data = await res.json();
  S.order = data.order;
  S.sources = data.folders;
  S.custom = data.customFolders;
  S.people = data.people;
  S.maxCustom = data.maxCustomFolders;
  S.photos = data.photos;
  byId.clear();
  for (const p of S.photos) byId.set(p.id, p);
  // Changes not yet on the server (from this visit, or kept on this device
  // from an earlier one) go back on screen and are sent.
  if (firstLoad) {
    firstLoad = false;
    saver.queue = device.read();
  }
  for (const { change } of [...saver.inflight, ...saver.queue]) applyLocal(change);
  if (saver.queue.length) saver.later(0);
  if (!keepPlace) S.openId = null;
  if (S.view.kind === 'folder' && !S.custom.includes(S.view.name)) S.view = { kind: 'all' };
  document.title = `${S.order.title} · Family Preserves`;
  $('eyebrow').textContent = `Order ${S.order.code} · ${plural(S.photos.length, 'photo', 'photos')}`;
  $('title').textContent = S.order.title;
  if (!S.photos.length) {
    $('main').innerHTML = '<p class="empty">Your photos are on their way. Please check back soon.</p>';
    renderSaveStatus();
    return;
  }
  render();
}

load();
