# Life Skills Committee — site

A small committee site with a video library, an admin panel for uploading
content, and Sign in with Freebuff for admin access. No code edits are needed
to add videos or photos.

- **Frontend:** static HTML/CSS/JS in `public/`
- **Backend:** one Cloudflare Worker (`src/worker.js`) + R2 bucket (`VIDEOS`)
- **Auth:** OIDC + PKCE against `https://freebuff.com/oidc`, session cookie `__session`
- **Deploy:** Sites (preview + production), built with esbuild

## Pages

| Page      | Path       | Notes |
|-----------|------------|-------|
| Home      | `/`        | Goals, quick links, and leadership line (Head — Joanna · Mistress — Mrs Natasha Steve) |
| Heads & Mistress | `/about` | Profile cards for Joanna and Mrs Natasha Steve (photos uploaded via admin) |
| Members   | `/members` | Placeholder names until the final roster is confirmed |
| Video Library | `/videos` | Videos grouped by skill category, with filter chips |
| Admin     | `/admin`   | Sign in to upload videos/photos, add videos by link, delete content |

## Using the admin panel

1. Open `/admin` and click **Sign in with Freebuff**.
2. Then you can:
   - **Upload a Video** — file up to ~80 MB, assign a skill category.
   - **Upload a Photo** — for a *Head* or the *Mistress* profile card.
   - **Add a Video by Link** — YouTube or a direct `https://…/clip.mp4` URL.
     Best for videos too large to upload; appears in the library alongside files.
3. The lists at the bottom show what's on the site; **Delete** removes an item.

## Development

```bash
npm install          # once
npm run build        # bundle worker (inlines jose) -> dist/worker.js
npm test             # local end-to-end suite (mock OIDC + in-memory R2)
npm test dist/worker.js   # run the same suite against the build output
```

`npm run build` must be run whenever `src/worker.js` changes — the deploy
manifest (`manifest.json`) uploads `dist/worker.js`, because the Sites
pipeline does not bundle npm dependencies itself.

## Architecture notes

- `src/worker.js` is the whole backend: auth routes, `/api/*` (auth-guarded,
  same-origin required for mutations), public streaming for `/videos/*` and
  `/images/*` (with Range support for seeking), then static assets.
- Uploads live in the R2 bucket bound as `VIDEOS`:
  `videos/…` for files, `videos/links/….json` for link records, `images/…` for photos.
- Sessions are verified with `jose` against the issuer's JWKS; the worker
  trusts only its own `__session` cookie, never client-supplied IDs.
- The local test suite in `tools/local-e2e.mjs` covers the full flow:
  sign-in (PKCE + state), callback → session, uploads, listing, range
  streaming, link videos, deletes, 401/403 guards, and static pages.
