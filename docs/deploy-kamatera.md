# Putting the gallery on the Kamatera server

This follows the same pattern as the kiosk and portal apps: Node runs as a
Windows service under NSSM, and Caddy serves HTTPS in front of it.

## 1. Cloudflare R2 (photo storage)

1. Sign up at https://dash.cloudflare.com (free). Open **R2 Object Storage**.
   R2 asks for a card, but the first 10 GB a month are free.
2. **Create bucket**: name it `familypreserves-gallery`. Leave it private (no
   public access). Location: Automatic.
3. **Manage R2 API Tokens → Create API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: `familypreserves-gallery` only
   - Create, then copy the **Access Key ID**, **Secret Access Key**, and your
     **Account ID** (shown on the R2 overview page). The secret is only shown
     once.

No CORS settings are needed: uploads come from the upload tool, not a browser,
and customers' browsers only display images.

## 2. DNS

Wherever familypreserves.ca's DNS is managed, add:

| Type | Name    | Value                     |
|------|---------|---------------------------|
| A    | gallery | your Kamatera server's IP |

## 3. The app

On the server (Node.js 20.12 or newer):

```
cd C:\
git clone https://github.com/jsalares/familypreserves_gallery.git
cd familypreserves_gallery
npm install --omit=dev
copy .env.example .env
notepad .env
```

Fill in `.env`: `PUBLIC_URL=https://gallery.familypreserves.ca`,
`PORT=3010` (any free port not used by kiosk or portal), the two random
secrets, `STORAGE=r2` and the four R2 values. Optionally set
`DATA_DIR=C:\familypreserves_gallery\data`.

Check it starts: `npm start`, then open http://127.0.0.1:3010/healthz on the
server. Stop it with Ctrl+C.

## 4. NSSM service

```
nssm install FamilyPreservesGallery "C:\Program Files\nodejs\node.exe" server\index.js
nssm set FamilyPreservesGallery AppDirectory C:\familypreserves_gallery
nssm set FamilyPreservesGallery AppStdout C:\familypreserves_gallery\data\service.log
nssm set FamilyPreservesGallery AppStderr C:\familypreserves_gallery\data\service.log
nssm set FamilyPreservesGallery AppRotateFiles 1
nssm set FamilyPreservesGallery AppRotateBytes 10485760
nssm start FamilyPreservesGallery
```

(Create the `data` folder first if NSSM complains about the log path.)

## 5. Caddy

Add to the Caddyfile next to the kiosk and portal sites, then reload Caddy:

```
gallery.familypreserves.ca {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3010
}
```

Caddy gets the HTTPS certificate on its own once the DNS record points at the
server.

## Updating later

```
cd C:\familypreserves_gallery
git pull
npm install --omit=dev
nssm restart FamilyPreservesGallery
```

## Backups

The server backs up the database to R2 every night after 3 AM (server time)
and keeps 30 days. Check the last one, or make one now, on the admin page at
`/admin`. The photos themselves are already in R2, and your own copies stay
on your PC. How to restore is in the README under "The admin page".
