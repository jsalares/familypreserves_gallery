// Family Preserves gallery admin: sign in with the admin token, then see every
// gallery, change end dates, give new access codes, delete galleries or
// scanned folders, and back up the database.

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/admin-session') location.reload();
  if (!res.ok) throw new Error(data.error || `Something went wrong (HTTP ${res.status}).`);
  return data;
}

// ------------------------------------------------------------------ sign-in

const signin = $('admin-signin');
if (signin) {
  signin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = signin.querySelector('button');
    btn.disabled = true;
    $('message').textContent = '';
    try {
      await api('POST', '/api/admin-session', { token: $('token').value });
      location.reload();
    } catch (err) {
      $('message').textContent = err.message;
      btn.disabled = false;
      $('token').focus();
    }
  });
}

// --------------------------------------------------------------- the page

const S = { data: null, find: '', ui: {} }; // ui[code] = { confirm, newCode, msg, err, busy, open }
const ui = (code) => (S.ui[code] ||= {});

const fmtBytes = (n) => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
};
const fmtDate = (d) =>
  new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function load() {
  try {
    S.data = await api('GET', '/api/admin/overview');
  } catch (err) {
    $('orders').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  render();
}

function renderBackup() {
  const b = S.data.backup;
  const latest = b.latest
    ? `Last backup <strong>${esc(new Date(b.latest.modified).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }))}</strong> · ${fmtBytes(b.latest.bytes)} · ${plural(b.count, 'copy', 'copies')} kept (up to ${b.keep})`
    : 'No backups yet. The first one runs tonight after 3 AM, or press the button.';
  const busy = S.backupBusy;
  $('backup').innerHTML = `<div>
      <h2>Database backup</h2>
      <p>${latest}</p>
      ${b.lastError ? `<p class="error">The last try failed: ${esc(b.lastError.message)}</p>` : ''}
      ${S.backupMsg ? `<p class="ok">${esc(S.backupMsg)}</p>` : ''}
    </div>
    <button type="button" class="btn" data-act="backup"${busy ? ' disabled' : ''}>${busy ? 'Backing up…' : 'Back up now'}</button>`;
}

function statusOf(o) {
  if (!o.expiresOn) return { cls: 'none', text: 'No end date' };
  if (o.expired) return { cls: 'closed', text: `Closed · ended ${fmtDate(o.expiresOn)}` };
  return { cls: 'open', text: `Open until ${fmtDate(o.expiresOn)}` };
}

function renderConfirm(o, u) {
  const c = u.confirm;
  if (!c) return '';
  const what =
    c.kind === 'order'
      ? `Delete <strong>${esc(o.title)}</strong> with all ${plural(o.photos, 'photo', 'photos')}, ${plural(o.rawFiles, 'raw file', 'raw files')} and the customer's folders and details? The files are removed from storage. This can't be undone.`
      : c.kind === 'folder'
        ? `Delete the scanned folder <strong>${esc(c.folder)}</strong> and its ${plural(c.photos, 'photo', 'photos')}? They also leave any custom folders the customer put them in. This can't be undone.`
        : `Give ${esc(o.code)} a new access code? The current code stops working right away.`;
  const typed = c.kind !== 'code';
  return `<div class="confirm" role="alertdialog" aria-label="Confirm">
      <p>${what}</p>
      ${typed ? `<label>Type <strong>${esc(o.code)}</strong> to confirm <input type="text" data-confirm="${esc(o.code)}" autocomplete="off" spellcheck="false"></label>` : ''}
      <div class="actions">
        <button type="button" class="btn ${typed ? 'btn-danger' : ''}" data-act="do-confirm" data-code="${esc(o.code)}"${u.busy ? ' disabled' : ''}>${
          u.busy ? 'Working…' : c.kind === 'code' ? 'Make a new code' : 'Delete'
        }</button>
        <button type="button" class="btn-plain" data-act="cancel" data-code="${esc(o.code)}">Cancel</button>
      </div>
    </div>`;
}

function renderOrder(o) {
  const u = ui(o.code);
  const st = statusOf(o);
  const stats = [
    plural(o.photos, 'photo', 'photos'),
    o.backs ? `${o.backs.toLocaleString()} with backs` : '',
    plural(o.rawFiles, 'raw file', 'raw files'),
    fmtBytes(o.bytes),
    plural(o.customFolders, 'custom folder', 'custom folders'),
  ].filter(Boolean);
  const code = esc(o.code);
  return `<article class="ord" data-order="${code}">
      <header>
        <div>
          <span class="eyebrow">${code} · added ${fmtDate(o.createdAt)}</span>
          <h2 class="serif">${esc(o.title)}</h2>
        </div>
        <span class="status ${st.cls}">${st.text}</span>
      </header>
      <p class="stats">${stats.join(' · ')}${o.restore ? ` · <strong class="restore">${plural(o.restore, 'photo', 'photos')} marked Restore</strong>` : ''}</p>
      <div class="actions">
        <a class="btn-plain" href="${esc(o.url)}" target="_blank" rel="noopener">Open gallery</a>
        <button type="button" class="btn-plain" data-act="copy" data-code="${code}">Copy link</button>
        <button type="button" class="btn-plain" data-act="ask-code" data-code="${code}">New access code</button>
        <button type="button" class="btn-plain" data-act="welcome" data-code="${code}">Show welcome again</button>
      </div>
      ${u.newCode ? `<p class="new-code">New access code: <strong>${esc(u.newCode)}</strong> <button type="button" class="btn-plain" data-act="copy-code" data-code="${code}">Copy</button></p>` : ''}
      <div class="expiry">
        <label>End date <input type="date" data-date="${code}" value="${esc(o.expiresOn || '')}"></label>
        <button type="button" class="btn-plain" data-act="save-date" data-code="${code}">Save</button>
        <button type="button" class="btn-plain" data-act="add-days" data-code="${code}">+${S.data.galleryDays || 90} days</button>
        ${o.expiresOn ? `<button type="button" class="btn-plain" data-act="no-end" data-code="${code}">No end date</button>` : ''}
      </div>
      <details class="folders"${u.open ? ' open' : ''} data-code="${code}">
        <summary>Scanned folders (${o.folders.length})</summary>
        <ul>${o.folders
          .map(
            (f) => `<li><span class="name">${esc(f.name)}</span><span class="n">${plural(f.photos, 'photo', 'photos')}</span>
              <button type="button" class="btn-plain danger" data-act="ask-folder" data-code="${code}" data-folder="${esc(f.name)}" data-photos="${f.photos}">Delete</button></li>`
          )
          .join('')}</ul>
      </details>
      ${u.msg ? `<p class="ok" role="status">${esc(u.msg)}</p>` : ''}
      ${u.err ? `<p class="error" role="alert">${esc(u.err)}</p>` : ''}
      ${renderConfirm(o, u)}
      ${u.confirm ? '' : `<div class="actions end"><button type="button" class="btn-plain danger" data-act="ask-order" data-code="${code}">Delete gallery</button></div>`}
    </article>`;
}

function render() {
  const d = S.data;
  renderBackup();
  $('defaults').textContent = d.galleryDays
    ? `New galleries stay open for ${d.galleryDays} days. Closed galleries keep their files until you delete them.`
    : 'New galleries have no end date.';
  const q = S.find.trim().toLowerCase();
  const list = d.orders.filter((o) => !q || `${o.code} ${o.title}`.toLowerCase().includes(q));
  $('count').textContent = `· ${d.orders.length}`;
  $('orders').innerHTML = (S.flash ? `<p class="ok flash" role="status">${esc(S.flash)}</p>` : '') + (list.length
    ? list.map(renderOrder).join('')
    : `<p class="note">${d.orders.length ? 'No gallery matches that.' : 'No galleries yet. Upload an order with the upload tool to make one.'}</p>`);
}

const order = (code) => S.data.orders.find((o) => o.code === code);

async function act(code, fn) {
  const u = ui(code);
  u.err = '';
  u.msg = '';
  try {
    await fn(u);
  } catch (err) {
    u.err = err.message;
  }
  render();
}

async function setDate(code, expiresOn) {
  await act(code, async (u) => {
    const out = await api('POST', `/api/admin/orders/${encodeURIComponent(code)}/expiry`, { expiresOn });
    Object.assign(order(code), { expiresOn: out.expiresOn, expired: out.expired });
    u.msg = out.expiresOn ? `Saved. ${out.expired ? 'The gallery is closed.' : `Open until ${fmtDate(out.expiresOn)}.`}` : 'Saved. No end date.';
  });
}

async function confirmed(code) {
  const u = ui(code);
  const c = u.confirm;
  if (c.kind !== 'code') {
    const typed = document.querySelector(`[data-confirm="${CSS.escape(code)}"]`)?.value.trim().toUpperCase();
    if (typed !== code) {
      u.err = `Type ${code} to confirm.`;
      render();
      document.querySelector(`[data-confirm="${CSS.escape(code)}"]`)?.focus();
      return;
    }
  }
  u.busy = true;
  render();
  const path = `/api/admin/orders/${encodeURIComponent(code)}`;
  await act(code, async () => {
    try {
      if (c.kind === 'code') {
        const out = await api('POST', `${path}/reset-code`);
        u.newCode = out.accessCode;
        u.msg = 'Give the customer this new code. The old one no longer works.';
      } else if (c.kind === 'order') {
        const out = await api('DELETE', path, { confirm: code });
        S.flash = `Deleted ${order(code).title} (${code}) and ${plural(out.filesDeleted, 'stored file', 'stored files')}.`;
        S.data.orders = S.data.orders.filter((o) => o.code !== code);
      } else {
        const out = await api('DELETE', `${path}/folders`, { confirm: code, folder: c.folder });
        u.msg = `Deleted ${c.folder}: ${plural(out.photosDeleted, 'photo', 'photos')}.`;
        await load();
      }
      u.confirm = null;
    } finally {
      u.busy = false;
    }
  });
}

if ($('orders')) {
  load();

  $('find').addEventListener('input', (e) => {
    S.find = e.target.value;
    if (S.data) render();
  });

  $('sign-out').addEventListener('click', async () => {
    await api('DELETE', '/api/admin-session').catch(() => {});
    location.reload();
  });

  document.addEventListener('toggle', (e) => {
    if (e.target.matches?.('details.folders')) ui(e.target.dataset.code).open = e.target.open;
  }, true);

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const code = t.dataset.code;
    const u = code ? ui(code) : null;
    S.flash = '';
    switch (t.dataset.act) {
      case 'backup':
        S.backupBusy = true;
        S.backupMsg = '';
        renderBackup();
        try {
          await api('POST', '/api/admin/backup');
          S.backupMsg = 'Backed up.';
        } catch (err) {
          S.backupMsg = '';
          alertBackup(err.message);
        }
        S.backupBusy = false;
        await load();
        return;
      case 'copy':
        await navigator.clipboard?.writeText(order(code).url).catch(() => {});
        u.msg = 'Link copied.';
        u.err = '';
        break;
      case 'copy-code':
        await navigator.clipboard?.writeText(u.newCode).catch(() => {});
        u.msg = 'Code copied.';
        break;
      case 'ask-code': u.confirm = { kind: 'code' }; u.err = ''; break;
      case 'ask-order': u.confirm = { kind: 'order' }; u.err = ''; break;
      case 'ask-folder':
        u.confirm = { kind: 'folder', folder: t.dataset.folder, photos: Number(t.dataset.photos) };
        u.err = '';
        break;
      case 'cancel': u.confirm = null; u.err = ''; break;
      case 'do-confirm': return confirmed(code);
      case 'save-date': {
        const v = document.querySelector(`[data-date="${CSS.escape(code)}"]`).value;
        return setDate(code, v || null);
      }
      case 'add-days': {
        const o = order(code);
        const from = o.expiresOn && !o.expired ? o.expiresOn : S.data.today;
        return setDate(code, addDays(from, S.data.galleryDays || 90));
      }
      case 'no-end': return setDate(code, null);
      case 'welcome':
        return act(code, async () => {
          await api('POST', `/api/admin/orders/${encodeURIComponent(code)}/welcome`);
          u.msg = 'Done. The next time this gallery is opened, on any device, it starts on the welcome screen.';
        });
      default: return;
    }
    render();
    if (u?.confirm) document.querySelector(`[data-confirm="${CSS.escape(code)}"]`)?.focus();
  });
}

function alertBackup(message) {
  S.data.backup.lastError = { message };
}
