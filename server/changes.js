// Customer edits arrive as small "changes". Each one states the result it wants
// ("photo 12 IS in Christmas", "photo 12's year IS 1985") rather than a step
// ("add one more"), so sending the same change twice is harmless. That lets
// the browser retry freely after a dropped connection.
//
// Custom folders and people are named, not numbered, in changes. Names are
// unique within an order, so the browser never has to wait for an id before
// it can use a folder or person it just created.

export const MAX_CUSTOM_FOLDERS = 8;
export const MAX_CHANGES_PER_REQUEST = 200;
const TEXT_FIELDS = { year: 20, place: 100, event: 100, caption: 1000 };
const NAME_MAX = 40;

export class ChangeError extends Error {}

function cleanName(value, what) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ChangeError(`${what} name is empty.`);
  if (name.length > NAME_MAX) throw new ChangeError(`${what} name is longer than ${NAME_MAX} characters.`);
  return name;
}

export function createChangeHandler(db) {
  const st = {
    photo: db.prepare('SELECT id FROM photos WHERE id = ? AND order_id = ?'),
    folder: db.prepare('SELECT id FROM custom_folders WHERE order_id = ? AND name = ?'),
    folderCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS last FROM custom_folders WHERE order_id = ?'),
    insertFolder: db.prepare('INSERT INTO custom_folders (order_id, name, position) VALUES (?, ?, ?)'),
    deleteFolder: db.prepare('DELETE FROM custom_folders WHERE order_id = ? AND name = ?'),
    link: db.prepare('INSERT OR IGNORE INTO photo_custom_folders (photo_id, folder_id) VALUES (?, ?)'),
    unlink: db.prepare('DELETE FROM photo_custom_folders WHERE photo_id = ? AND folder_id = ?'),
    person: db.prepare('SELECT id FROM people WHERE order_id = ? AND name = ?'),
    insertPerson: db.prepare('INSERT INTO people (order_id, name) VALUES (?, ?)'),
    tag: db.prepare('INSERT OR IGNORE INTO photo_people (photo_id, person_id) VALUES (?, ?)'),
    untag: db.prepare('DELETE FROM photo_people WHERE photo_id = ? AND person_id = ?'),
    enhance: db.prepare('UPDATE photos SET enhance = ? WHERE id = ? AND order_id = ?'),
    field: Object.fromEntries(
      Object.keys(TEXT_FIELDS).map((f) => [f, db.prepare(`UPDATE photos SET ${f} = ? WHERE id = ? AND order_id = ?`)])
    ),
  };

  const needPhoto = (orderId, photoId) => {
    const id = Number(photoId);
    if (!Number.isInteger(id) || !st.photo.get(id, orderId)) throw new ChangeError('That photo is not in this gallery.');
    return id;
  };

  const ensureFolder = (orderId, rawName) => {
    const name = cleanName(rawName, 'Folder');
    const found = st.folder.get(orderId, name);
    if (found) return found.id;
    const { n, last } = st.folderCount.get(orderId);
    if (n >= MAX_CUSTOM_FOLDERS) throw new ChangeError(`You can have up to ${MAX_CUSTOM_FOLDERS} custom folders.`);
    return st.insertFolder.run(orderId, name, last + 1).lastInsertRowid;
  };

  const ensurePerson = (orderId, rawName) => {
    const name = cleanName(rawName, 'Person');
    const found = st.person.get(orderId, name);
    return found ? found.id : st.insertPerson.run(orderId, name).lastInsertRowid;
  };

  function applyOne(orderId, c) {
    switch (c?.op) {
      case 'folder.create':
        ensureFolder(orderId, c.name);
        return;
      case 'folder.delete':
        // Removes the folder and its copies only; original photos are untouched.
        st.deleteFolder.run(orderId, cleanName(c.name, 'Folder'));
        return;
      case 'photo.folder': {
        const photoId = needPhoto(orderId, c.photoId);
        if (c.on) {
          st.link.run(photoId, ensureFolder(orderId, c.name));
        } else {
          const f = st.folder.get(orderId, cleanName(c.name, 'Folder'));
          if (f) st.unlink.run(photoId, f.id);
        }
        return;
      }
      case 'photo.person': {
        const photoId = needPhoto(orderId, c.photoId);
        if (c.on) {
          st.tag.run(photoId, ensurePerson(orderId, c.name));
        } else {
          const p = st.person.get(orderId, cleanName(c.name, 'Person'));
          if (p) st.untag.run(photoId, p.id);
        }
        return;
      }
      case 'photo.field': {
        const max = TEXT_FIELDS[c.field];
        if (!max) throw new ChangeError('Unknown detail.');
        const value = String(c.value ?? '').trim();
        if (value.length > max) throw new ChangeError(`That ${c.field} is too long.`);
        st.field[c.field].run(value || null, needPhoto(orderId, c.photoId), orderId);
        return;
      }
      case 'photo.enhance':
        st.enhance.run(c.on ? 1 : 0, needPhoto(orderId, c.photoId), orderId);
        return;
      default:
        throw new ChangeError('Unknown change.');
    }
  }

  // Applies changes in order. Each is its own small transaction, so one bad
  // change (say, a ninth folder) doesn't throw away the good ones around it.
  return function applyChanges(orderId, changes) {
    return changes.map((c) => {
      try {
        db.transaction(() => applyOne(orderId, c))();
        return { ok: true };
      } catch (err) {
        if (err instanceof ChangeError) return { ok: false, error: err.message };
        throw err;
      }
    });
  };
}

// Everything the gallery screen needs about the customer's own work.
export function loadOrganizing(db, orderId) {
  const customFolders = db
    .prepare('SELECT id, name FROM custom_folders WHERE order_id = ? ORDER BY position, id')
    .all(orderId);
  const people = db.prepare('SELECT id, name FROM people WHERE order_id = ? ORDER BY name COLLATE NOCASE').all(orderId);
  const folderLinks = db
    .prepare(
      `SELECT l.photo_id, f.name FROM photo_custom_folders l
       JOIN custom_folders f ON f.id = l.folder_id WHERE f.order_id = ? ORDER BY f.position, f.id`
    )
    .all(orderId);
  const personLinks = db
    .prepare(
      `SELECT l.photo_id, p.name FROM photo_people l
       JOIN people p ON p.id = l.person_id WHERE p.order_id = ? ORDER BY p.name COLLATE NOCASE`
    )
    .all(orderId);
  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.photo_id)) m.set(r.photo_id, []);
      m.get(r.photo_id).push(r.name);
    }
    return m;
  };
  return {
    customFolders: customFolders.map((f) => f.name),
    people: people.map((p) => p.name),
    foldersByPhoto: group(folderLinks),
    peopleByPhoto: group(personLinks),
  };
}
