import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Each entry upgrades the database by one version. Never edit a shipped entry;
// add a new one instead.
export const MIGRATIONS = [
  `
  CREATE TABLE orders (
    id            INTEGER PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,          -- e.g. FP-1042
    title         TEXT NOT NULL,                 -- e.g. The Martin Family Collection
    slug          TEXT NOT NULL UNIQUE,          -- e.g. fp-1042-k7q3mx (the gallery URL)
    access_hash   TEXT NOT NULL,                 -- scrypt hash of the access code
    expires_at    TEXT,                          -- ISO date; NULL = never
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Scanned folders (albums, boxes), as Jason organised the scans. Customers
  -- can read but never change them.
  CREATE TABLE source_folders (
    id        INTEGER PRIMARY KEY,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (order_id, name)
  );

  -- One row per scan. The photo's details live here once, so every
  -- custom-folder "copy" (a link in photo_custom_folders) shares them.
  CREATE TABLE photos (
    id                INTEGER PRIMARY KEY,
    order_id          INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    source_folder_id  INTEGER NOT NULL REFERENCES source_folders(id) ON DELETE CASCADE,
    filename          TEXT NOT NULL,
    position          INTEGER NOT NULL DEFAULT 0,
    sha256            TEXT NOT NULL,
    bytes             INTEGER NOT NULL,
    width             INTEGER,
    height            INTEGER,
    original_key      TEXT NOT NULL,
    screen_key        TEXT NOT NULL,
    thumb_key         TEXT NOT NULL,
    year              TEXT,
    place             TEXT,
    event             TEXT,
    caption           TEXT,
    enhance           INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (order_id, source_folder_id, filename)
  );

  -- The customer's own folders. Photos in them are links, not file copies.
  CREATE TABLE custom_folders (
    id        INTEGER PRIMARY KEY,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL DEFAULT 0,
    UNIQUE (order_id, name)
  );

  CREATE TABLE photo_custom_folders (
    photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    folder_id  INTEGER NOT NULL REFERENCES custom_folders(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, folder_id)
  );

  CREATE TABLE people (
    id        INTEGER PRIMARY KEY,
    order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    UNIQUE (order_id, name)
  );

  CREATE TABLE photo_people (
    photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, person_id)
  );

  CREATE INDEX photos_by_order ON photos (order_id, source_folder_id, position);
  `,
  // 2: each photo is a pair. The file customers see is the ENHANCED version
  // (colour corrected); the raw scan is the ORIGINAL, kept only for download.
  // What version 1 called original_key was always the file customers saw.
  `
  ALTER TABLE photos RENAME COLUMN original_key TO enhanced_key;
  ALTER TABLE photos ADD COLUMN raw_filename TEXT;
  ALTER TABLE photos ADD COLUMN raw_sha256 TEXT;
  ALTER TABLE photos ADD COLUMN raw_bytes INTEGER;
  ALTER TABLE photos ADD COLUMN raw_key TEXT;
  `,
];

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'gallery.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

// Natural sort so "scan2" comes before "scan10".
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

export function createQueries(db) {
  const q = {
    orderByCode: db.prepare('SELECT * FROM orders WHERE code = ?'),
    orderBySlug: db.prepare('SELECT * FROM orders WHERE slug = ?'),
    insertOrder: db.prepare(
      'INSERT INTO orders (code, title, slug, access_hash) VALUES (@code, @title, @slug, @access_hash)'
    ),
    setAccessHash: db.prepare('UPDATE orders SET access_hash = ? WHERE id = ?'),
    sourceFolder: db.prepare('SELECT * FROM source_folders WHERE order_id = ? AND name = ?'),
    insertSourceFolder: db.prepare('INSERT INTO source_folders (order_id, name) VALUES (?, ?)'),
    sourceFolders: db.prepare('SELECT * FROM source_folders WHERE order_id = ? ORDER BY position, id'),
    setSourceFolderPosition: db.prepare('UPDATE source_folders SET position = ? WHERE id = ?'),
    upsertPhoto: db.prepare(`
      INSERT INTO photos (order_id, source_folder_id, filename, sha256, bytes, width, height,
                          enhanced_key, screen_key, thumb_key,
                          raw_filename, raw_sha256, raw_bytes, raw_key)
      VALUES (@order_id, @source_folder_id, @filename, @sha256, @bytes, @width, @height,
              @enhanced_key, @screen_key, @thumb_key,
              @raw_filename, @raw_sha256, @raw_bytes, @raw_key)
      ON CONFLICT (order_id, source_folder_id, filename) DO UPDATE SET
        sha256 = excluded.sha256, bytes = excluded.bytes, width = excluded.width,
        height = excluded.height, enhanced_key = excluded.enhanced_key,
        screen_key = excluded.screen_key, thumb_key = excluded.thumb_key,
        raw_filename = excluded.raw_filename, raw_sha256 = excluded.raw_sha256,
        raw_bytes = excluded.raw_bytes, raw_key = excluded.raw_key
    `),
    photosInFolder: db.prepare('SELECT id, filename FROM photos WHERE source_folder_id = ?'),
    setPhotoPosition: db.prepare('UPDATE photos SET position = ? WHERE id = ?'),
    photosForOrder: db.prepare(`
      SELECT p.*, f.name AS source_folder
      FROM photos p JOIN source_folders f ON f.id = p.source_folder_id
      WHERE p.order_id = ?
      ORDER BY f.position, f.id, p.position, p.id
    `),
    countPhotos: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE order_id = ?'),
  };

  // Keep folders and photos in natural filename order after every registration,
  // so re-running an upload with new files still sorts correctly.
  q.renumber = db.transaction((orderId) => {
    const folders = q.sourceFolders.all(orderId).sort((a, b) => naturalCompare(a.name, b.name));
    folders.forEach((f, i) => {
      q.setSourceFolderPosition.run(i, f.id);
      q.photosInFolder
        .all(f.id)
        .sort((a, b) => naturalCompare(a.filename, b.filename))
        .forEach((p, j) => q.setPhotoPosition.run(j, p.id));
    });
  });

  return q;
}
