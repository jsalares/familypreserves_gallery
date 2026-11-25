# Family Preserves gallery

The private online gallery where Family Preserves customers see their digitized
photos, sort copies into their own folders, add details, turn photos, mark
photos for restoration and download them.

Live address: **https://gallery.familypreserves.ca**

## How it fits together

```
Your PC                         Kamatera server                    Cloudflare R2
───────                         ───────────────                    ─────────────
Orders\FP-1042 Martin\   ──►    gallery app (Node, run by NSSM)    enhanced photos (+ backs)
  Album 1\ …                    behind Caddy (HTTPS)               raw scans, as they are
  Album 1\raw\ …               SQLite database: orders, folders,  screen-size copies
upload tool (npm run upload)    details, access codes              thumbnails
```

- **Your PC**: one folder per order, one subfolder per album, box or carousel.
  The photos in each subfolder are the enhanced (colour-corrected) versions;
  `scan001_b.jpg` is the back of `scan001.jpg`. Raw scans sit in a `raw`
  folder. The upload tool makes thumbnails, uploads everything and creates the
  gallery. Each subfolder becomes one of the customer's *scanned folders*.
- **Customers see and sort the enhanced versions**, with the back beside the
  front. Raw scans are uploaded exactly as they are, only for the download.
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
- Lay the order out like this:

  ```
  FP-1042 Martin\
    Album 1\scan001.jpg        enhanced photo (.jpg, .png, .tif)
    Album 1\scan001_b.jpg      the back of scan001, shown beside it
    Album 1\raw\…              raw scans: any files, uploaded untouched
  ```

  A `raw` folder can also sit once in the order folder instead of in each
  album. The tool warns about a `_b` file with no matching front (it is
  uploaded as its own photo).
- Photos sitting directly in the order folder go into "Other photos" (or
  "Photos" when there are no album folders).

Lost the code, or need to cut off access? `npm run reset-code -- FP-1042`
prints a new code; the old one stops working.

## The admin page

Open `https://gallery.familypreserves.ca/admin` and paste the `ADMIN_TOKEN`
from the server's `.env` (the browser stays signed in for 12 hours). For each
gallery you can:

- see its photos, backs, raw files, size, custom folders, and how many photos
  the customer marked **Restore**;
- open it, copy its link, or give it a **new access code** (the old one stops
  working);
- set its **end date**, add 90 days, or remove the end date. A gallery is open
  through its end date (Ottawa time) and shows "This gallery has closed" from
  the next morning. Files are kept until you delete the gallery. New galleries
  get an end date `GALLERY_DAYS` days out (90 unless set in `.env`; `0` means
  no end date);
- **delete one scanned folder** (for example one uploaded by mistake) or the
  **whole gallery**, files included. Both ask you to type the order code.

**Backups:** every night after 3 AM the server copies the database to R2 as
`backups/gallery-YYYY-MM-DD.sqlite` and keeps the newest 30. The admin page
shows the last one and has a **Back up now** button. To restore: stop the
service, download a backup from the R2 dashboard, and put it in place of
`data\gallery.sqlite`, then start the service.

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
3. **Done:** changes are kept on the customer's device until the server has
   them, so closing the tab, losing signal or a flat battery loses nothing;
   they are sent on the next visit. Undo button (and Ctrl+Z) for recent edits.
4. **Done:** zip downloads. The customer ticks scanned folders, custom folders
   and the raw scans. The zip is built while it downloads (no waiting, any
   size). Enhanced photos and their copies get the details written in with
   ExifTool (year as the date taken, caption, place, event, people, folder
   names as tags) and their turn applied; raw scans are never touched.
   ExifTool comes with `npm install`; nothing extra to install on the server.
5. **Done:** admin page, gallery end dates, deleting, nightly database backup.
   See "The admin page" above.
