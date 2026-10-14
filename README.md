# Life Skills Committee — site

A small committee site with a video library and an admin panel for adding
videos. No code edits are needed to add content.

- **Frontend:** static HTML/CSS/JS in `public/` (no build step)
- **Backend:** Vercel Functions in `api/`, shared code in `lib/`
- **Storage:** one Vercel Blob store (videos and their records)
- **Auth:** one shared admin passcode (`ADMIN_PASSWORD`) → signed session cookie

## Pages

| Page      | Path       | Notes |
|-----------|------------|-------|
| Home      | `/`        | Goals and quick links |
| Members   | `/members` | Placeholder names until the final roster is confirmed |
| Video Library | `/videos` | Videos grouped by skill category, with filter chips |
| Admin     | `/admin`   | Sign in to upload videos, add videos by link, delete content |

## One-time setup

1. **Create the Blob store** — Vercel dashboard → your project → *Storage* →
   *Create* → **Blob** → connect it to the project. Vercel then injects
   `BLOB_READ_WRITE_TOKEN` into every environment.
2. **Set the passcode** — Vercel dashboard → project → *Settings* →
   *Environment Variables* → add `ADMIN_PASSWORD` with the passcode the
   committee will share. Pick something long; the sign-in page is public.
3. **Redeploy** so the functions pick the variables up.

Until both are set, the site works normally but `/admin` shows exactly what is
missing instead of an upload form.

## Using the admin panel

1. Open `/admin` and enter the passcode.
2. Then you can:
   - **Upload a Video** — up to 200 MB (mp4, webm, mov, m4v, ogv), assigned to a
     skill category. The file goes straight from the browser to Blob storage, so
     size is no problem; long sessions are cheaper as links.
   - **Add a Video by Link** — YouTube or a direct `https://…/clip.mp4` URL.
3. The lists at the bottom show what is on the site; **Delete** removes an item.

Storage is a 1 GB free Vercel Blob store, so treat uploaded files as the
exception and links (YouTube) as the default for long videos.

## Development

```bash
npm install          # once
npm run dev          # local server: real api/ handlers + public/  -> http://localhost:3000
npm run test         # end-to-end suite for the Cloudflare worker (src/worker.js)
npm run test:api     # suite for the Vercel backend (lib/ + api/)
```

`npm run dev` serves `public/` and mounts every function in `api/` the way
Vercel does. Add a `.env.local` (git-ignored) to exercise real uploads locally:

```
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…
ADMIN_PASSWORD=whatever-you-like
```

`npm run test:api` runs its pure and handler-level checks with or without those
values, and additionally runs real-store integration checks when a token is
available.

The admin panel imports the browser build of `@vercel/blob/client` from
`public/js/vendor/vercel-blob-client.mjs`. Re-generate it after upgrading the
package: `npm run build:vendor`.

## Architecture notes

- `public/` is copied to the CDN as-is. `vercel.json` rewrites the clean paths
  (`/members`, `/videos`, `/admin`) onto the real `.html` files.
- `api/*.js` are Vercel Functions using the Web `fetch` signature; each file is
  one route:

  | Route | Methods | Access |
  |-------|---------|--------|
  | `/api/videos` | GET, POST (link), DELETE (`?key=`) | GET public, rest admin |
  | `/api/upload-video` | POST | admin |
  | `/api/auth-login` | POST | public (passcode) |
  | `/api/auth-user` | GET | session |
  | `/api/auth-logout` | POST | session |

- **Uploads cannot pass through a function**: Vercel caps request bodies at
  4.5 MB, so the browser asks `/api/upload-video` for a short-lived client token
  (only for one exact `videos/<32 hex>.<ext>` pathname, admin-only), uploads the
  file itself directly to Blob, then calls the same endpoint again to record it.
  The API verifies the blob exists before writing the record.
- **Records:** `data/videos/<id>.json` holds the original filename, category,
  size, URL and timestamp; media lives at `videos/<id>.<ext>`. Records are
  written once and deleted together with their file, so simultaneous uploads
  cannot clash. The pages read the records, which is what makes titles and
  categories survive.
- **Sessions:** the passcode is never stored in the browser — only an
  `HttpOnly`, `SameSite=Lax` `__session` cookie holding `<issuedAt>.<hmac>`,
  valid for 30 days. Mutating routes additionally require a same-origin request.
- **Caching:** public lists are served with `s-maxage=30` (one blob call per
  minute instead of one per page view); the admin panel asks for `?fresh=1` to
  always see the truth.
- `src/worker.js` is the original single-file Cloudflare Worker (R2 + Freebuff
  OIDC) for a Sites deploy. It still builds and passes `npm test`, but the
  deployed site runs the Vercel functions above; the two are not interchangeable.
