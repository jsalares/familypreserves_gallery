# Family Preserves gallery

The private online gallery where Family Preserves customers see their digitized
photos, sort copies into their own folders, add details, mark photos for
enhancement and download them.

Live address: **https://gallery.familypreserves.ca**

## How it fits together

```
Your PC                         Kamatera server                    Cloudflare R2
───────                         ───────────────                    ─────────────
Orders\FP-1042 Martin\   ──►    gallery app (Node, run by NSSM)    originals (raw scans)
  Original\Album 1\ …          behind Caddy (HTTPS)               enhanced versions
  Enhanced\Album 1\ …          SQLite database: orders, folders,  screen-size copies
upload tool (npm run upload)    details, access codes              thumbnails
```

- **Your PC**: each order folder has an `Original` folder (the raw scans) and
  an `Enhanced` folder (the colour-corrected versions), each with the same
  subfolders: one per album, box or carousel. The upload tool matches every
  raw scan with its enhanced version, makes thumbnails, uploads everything and
  creates the gallery. Each subfolder becomes one of the customer's *scanned
  folders*.
- **Customers see and sort the enhanced versions.** The raw originals are only
  stored, for the download.
- **The server** holds the database and hands out short-lived links to photos.
- **Cloudflare R2** stores the photos. Customers load them straight from R2, so
  viewing and downloading don't use the server's bandwidth.

Customers open their own link (for example
`gallery.familypreserves.ca/g/fp-1042-k7q3mx2p`) and type their access code
(for example `PINE-4821`). Their browser stays signed in for 60 days. Five
wrong codes lock that gallery for 15 minutes from that address.

## Uploading an order (on your PC)

One-time setup: install Node.js 20.12 or newer, then in this folder run
`npm install`, copy `.env.example` to `.env`, and fill in `GALLERY_URL` and
`ADMIN_TOKEN` (the same token the server uses).

```
npm run upload -- "C:\Orders\FP-1042 Martin" --order FP-1042 --title "The Martin Family Collection"
```

- The first run prints the gallery link and access code, and saves them in
  `gallery-access.txt` inside the order folder. Give these to the customer.
- If the upload stops (internet drop, PC sleeps), run the same command again.
  Anything already uploaded is skipped.
- Added more scans later? Put them in the folder and run it again.
- Lay the order out like this. A raw scan and its enhanced version are matched
  by subfolder and file name; the extension can differ.

  ```
  FP-1042 Martin\
    Original\Album 1\scan001.tif     raw scan (also .jpg, .png, .dng)
    Enhanced\Album 1\scan001.jpg     what the customer sees (.jpg, .png, .tif)
  ```

  The tool lists any enhanced photo with no original (it is still uploaded)
  and any original with no enhanced version (skipped), so you can fix them and
  run it again. An order folder with no `Original`/`Enhanced` folders is
  uploaded as enhanced photos only.
- Photos sitting directly in `Enhanced` go into "Other photos".

Lost the code, or need to cut off access? `npm run reset-code -- FP-1042`
prints a new code; the old one stops working.

## Trying it on your own PC

```
copy .env.example .env      (set STORAGE=local, PUBLIC_URL=http://localhost:3010,
                             PORT=3010, and make up SESSION_SECRET and ADMIN_TOKEN)
npm install
npm start
```

Then upload a test order with `GALLERY_URL=http://localhost:3010` and open the
link it prints. With `STORAGE=local`, photos are kept in the `data` folder
instead of R2.

## Putting it on the server

See [docs/deploy-kamatera.md](docs/deploy-kamatera.md): Cloudflare R2 setup,
the NSSM service, the Caddy site and the DNS record.

## Tests

```
npm test
```

The tests run the real app with local storage, upload a small sample order with
the upload tool, and sign in as a customer.

## Roadmap

1. **Done:** database, access-code sign-in, upload tool, simple gallery.
2. **Done:** the full sorting screen from the prototype: custom folders, details
   (year, place, event, people, caption), Enhance. Changes save in the
   background and retry on their own; the page warns before closing with
   unsaved changes.
3. Changes saved on the device first and synced in the background, so nothing
   is lost on a bad connection.
4. Zip downloads: the customer ticks *Originals (raw scans)*, *Enhanced* and any
   of their custom folders. Custom folders hold enhanced copies; the details
   are written into the enhanced files, and the raw originals stay exactly as
   scanned.
5. Nightly database backup to R2, gallery expiry, small admin page.
