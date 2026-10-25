<div align="center">

# Life Skills Committee — Site

**A committee website with a video library and a passcode-protected admin panel. Content is added from the browser — no code edits, no redeploy.**

HTML · CSS · Vanilla JS · Vercel Functions · Vercel Blob

[![Live demo](https://img.shields.io/badge/live%20demo-lifeskill--dusky.vercel.app-16a34a?style=flat-square)](https://lifeskill-dusky.vercel.app)
[![License: MIT](https://img.shields.io/badge/license-MIT-3b82f6?style=flat-square)](LICENSE)

</div>

## Overview

A static front end in `public/` with no build step, a handful of Vercel Functions in
`api/` that share code from `lib/`, one Vercel Blob store for the videos and their
records, and a single shared admin passcode that signs a session cookie. The committee
signs in at `/admin`, uploads files or pastes YouTube links, and the public library
updates.

Uploads go **straight from the browser to Blob storage** rather than through a function,
because Vercel caps request bodies at 4.5 MB; the API only hands out a short-lived,
path-locked client token and then records the result after verifying the blob exists.

| Concern | Implementation |
| --- | --- |
| Frontend | Static HTML/CSS/JS in `public/` |
| Backend | Vercel Functions in `api/`, shared code in `lib/` |
| Storage | One Vercel Blob store (media + JSON records) |
| Auth | Shared `ADMIN_PASSWORD` → signed, `HttpOnly` session cookie |
| Throttling | Failed sign-ins rate-limited per address; shared via Upstash Redis when configured |

## Pages

| Page | Path | Notes |
| --- | --- | --- |
| Home | `/` | Goals and quick links |
| Members | `/members` | Placeholder names until the final roster is confirmed |
| Video Library | `/videos` | Videos grouped by skill category, with filter chips |
| Admin | `/admin` | Sign in to upload videos, add videos by link, delete content |

`vercel.json` rewrites the clean paths onto the real `.html` files (`/members` →
`/members.html`, and so on), and `public/404.html` handles unknown paths.

## One-time setup

1. **Create the Blob store** — Vercel dashboard → your project → *Storage* → *Create* →
   **Blob** → connect it to the project. Vercel then injects `BLOB_READ_WRITE_TOKEN` into
   every environment.
2. **Set the passcode** — project → *Settings* → *Environment Variables* → add
   `ADMIN_PASSWORD`. Pick something long; the sign-in page is public.
3. **Set a session secret (recommended)** — add `SESSION_SECRET` with a long random value
   (e.g. `openssl rand -hex 32`). It signs the session cookie, so a stolen cookie cannot be
   used to guess the passcode offline. Without it the passcode is the signing key.
4. **Connect a shared rate-limit store (recommended)** — create a free Upstash Redis
   database (or add it from the Vercel Marketplace) and set
   `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. Throttling is then shared across
   every function instance; without it, it falls back to per-instance memory.
5. **Redeploy** so the functions pick the variables up.

Until the Blob store and passcode are set, the site works normally but `/admin` shows
exactly what is missing instead of an upload form.

## Using the admin panel

1. Open `/admin` and enter the passcode.
2. Then you can:
   - **Upload a Video** — up to 200 MB (mp4, webm, mov, m4v, ogv), assigned to a skill
     category. The file goes straight from the browser to Blob storage, so size is not a
     problem; long sessions are cheaper as links.
   - **Add a Video by Link** — YouTube or a direct `https://…/clip.mp4` URL.
3. The lists at the bottom show what is on the site; **Delete** removes an item.

Storage is a 1 GB free Vercel Blob store, so treat uploaded files as the exception and
links (YouTube) as the default for long videos.

## Getting started

```bash
npm install            # once
npm run dev            # local server: real api/ handlers + public/ → http://localhost:3000
```

### Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Serves `public/` and mounts every `api/` function the way Vercel does |
| `npm run test` | Backend suite: pure rules, handlers, browser upload contract |
| `npm run test:api` | Alias for the same suite |
| `npm run check:classes` | Verifies every CSS class used in HTML/JS exists in `style.css` |
| `npm run build:vendor` | Regenerates the vendored Blob browser client |

Add a git-ignored `.env.local` to exercise real uploads locally:

```bash
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_…
ADMIN_PASSWORD=whatever-you-like
SESSION_SECRET=any-long-random-string       # optional; falls back to ADMIN_PASSWORD
UPSTASH_REDIS_REST_URL=https://…upstash.io  # optional; enables shared throttling
UPSTASH_REDIS_REST_TOKEN=…
```

`npm run test` runs its pure and handler-level checks with or without those values, and
additionally runs real-store integration checks when a token is available.

The admin panel imports the browser build of `@vercel/blob/client` from
`public/js/vendor/vercel-blob-client.mjs`; regenerate it after upgrading the package with
`npm run build:vendor`.

## Architecture notes

- `public/` is copied to the CDN as-is — there is no bundler for the site itself.
- `api/*.js` are Vercel Functions using the Web `fetch` signature; each file is one route:

  | Route | Methods | Access |
  | --- | --- | --- |
  | `/api/videos` | GET, POST (link), DELETE (`?key=`) | GET public, rest admin |
  | `/api/upload-video` | POST | admin |
  | `/api/auth-login` | POST | public (passcode) |
  | `/api/auth-user` | GET | session |
  | `/api/auth-logout` | POST | session |

- **Uploads cannot pass through a function** — the browser asks `/api/upload-video` for a
  short-lived client token (only for one exact `videos/<32 hex>.<ext>` pathname,
  admin-only), uploads the file directly to Blob, then calls the same endpoint again to
  record it. The API verifies the blob exists before writing the record.
- **Records** — `data/videos/<id>.json` holds the original filename, category, size, URL
  and timestamp; media lives at `videos/<id>.<ext>`. Records are written once and deleted
  together with their file, so simultaneous uploads cannot clash. The pages read the
  records, which is what makes titles and categories survive.
- **Sessions** — the passcode is never stored in the browser, only an `HttpOnly`,
  `SameSite=Lax` `__session` cookie holding `<issuedAt>.<hmac>`, valid for 30 days. The
  HMAC is keyed on `SESSION_SECRET` when set, else the passcode. Mutating routes
  additionally require a same-origin request.
- **Rate limiting** — `lib/ratelimit.js` throttles failed sign-ins per address (10 failures
  / 15 minutes) on a fixed window. With Upstash Redis configured the counter is shared by
  every serverless instance via its REST API — no npm dependency. If the store is unset or
  unreachable it falls back to a bounded per-instance memory map so sign-in keeps working.
- **Caching** — public lists are served with `s-maxage=30` (one blob call per minute instead
  of one per page view); the admin panel asks for `?fresh=1` to always see the truth.
- **Hardening** — `vercel.json` sets CSP, HSTS, `nosniff`, `frame-ancestors` and
  `Permissions-Policy`; HTML is served `no-cache`, JS/CSS with a day of cache.

## Project layout

```
public/                 Static site (HTML, CSS, JS, 404 page, vendored Blob client)
api/                    One file per route: videos, upload-video, auth-*
lib/                    auth, http helpers, media, rate limiting, blob store, upload handler
tools/                  local api server, API test suite, class checker, vendor build
vercel.json             Rewrites + security headers + cache policy
```

## License

[MIT](LICENSE) © 2026 CoderGamerUnknow
