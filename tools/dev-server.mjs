/**
 * Local dev server for the Life Skills Committee worker.
 *
 * Cloudflare's `wrangler dev` is not installable here (no registry access and
 * no workerd binary), so this runs the *real* src/worker.js inside Node against
 * the same fakes the test suite already proves correct:
 *
 *   - a mock OIDC provider mounted at /oidc on the same origin, which serves a
 *     browsable sign-in page so the whole admin flow can be clicked through
 *   - an R2 bucket backed by .dev-data/ on disk (uploads survive restarts)
 *   - static assets served from public/
 *
 * Usage:  npm run dev:worker     (defaults to http://localhost:8787)
 *         PORT=3000 npm run dev:worker
 *
 * Open the printed URL, go to /admin and sign in as any listed account.
 */

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = join(ROOT, ".dev-data");
const CLIENT_ID = "dev-client";

// `|| 8787` also swallows PORT=0 (some runners inject that), which would
// otherwise bind a random ephemeral port.
const PORT = Number(process.env.PORT) || 8787;

// ============================================================
//  Accounts offered on the mock sign-in page
// ============================================================

const ACCOUNTS = [
  { sub: "user-joanna", email: "joanna@example.com", name: "Joanna", role: "Admin" },
  {
    sub: "user-natasha",
    email: "natasha@example.com",
    name: "Mrs Natasha Steve",
    role: "Admin",
  },
  { sub: "user-member", email: "member@example.com", name: "Committee Member", role: "Member" },
];

// ============================================================
//  Disk-backed R2 bucket (.dev-data/objects + .dev-data/index.json)
// ============================================================

const OBJECTS_DIR = join(DATA_DIR, "objects");
const INDEX_FILE = join(DATA_DIR, "index.json");

function blobPath(key) {
  // Keys contain slashes; flatten them into a single safe filename.
  return join(OBJECTS_DIR, encodeURIComponent(key));
}

async function loadIndex() {
  try {
    return JSON.parse(await readFile(INDEX_FILE, "utf8"));
  } catch {
    return {};
  }
}

let index = await loadIndex();

async function saveIndex() {
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2));
}

function parseRange(header, size) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || "").trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : size - 1;
  if (start >= size) return null;
  const length = Math.min(end, size - 1) - start + 1;
  if (length <= 0) return null;
  return { offset: start, length };
}

const bucket = {
  async put(key, value, opts = {}) {
    let buf;
    if (typeof value === "string") buf = Buffer.from(value, "utf8");
    else if (value instanceof Blob) buf = Buffer.from(await value.arrayBuffer());
    else if (value instanceof ArrayBuffer) buf = Buffer.from(value);
    else if (ArrayBuffer.isView(value))
      buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (value && typeof value.getReader === "function")
      buf = Buffer.from(await new Response(value).arrayBuffer());
    else buf = Buffer.from(String(value));

    await writeFile(blobPath(key), buf);
    index[key] = {
      size: buf.length,
      uploaded: new Date().toISOString(),
      httpMetadata: opts.httpMetadata || {},
      customMetadata: opts.customMetadata || {},
    };
    await saveIndex();
  },

  async get(key, opts = {}) {
    const meta = index[key];
    if (!meta) return null;
    let buf;
    try {
      buf = await readFile(blobPath(key));
    } catch {
      return null;
    }

    const rangeHeader =
      opts.range && typeof opts.range.get === "function" ? opts.range.get("range") : null;
    const range = rangeHeader ? parseRange(rangeHeader, buf.length) : null;
    const slice = range ? buf.subarray(range.offset, range.offset + range.length) : buf;

    return {
      key,
      size: buf.length,
      etag: `"${meta.size}-${String(meta.uploaded).length}"`,
      httpEtag: `"${meta.size}"`,
      httpMetadata: meta.httpMetadata,
      customMetadata: meta.customMetadata,
      range: range || undefined,
      body: Readable.toWeb(Readable.from(slice)),
      async text() {
        return slice.toString("utf8");
      },
      async json() {
        return JSON.parse(slice.toString("utf8"));
      },
      async arrayBuffer() {
        return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
      },
      writeHttpMetadata(headers) {
        for (const [k, v] of Object.entries(meta.httpMetadata || {})) {
          if (v == null) continue;
          if (k === "contentType") headers.set("Content-Type", String(v));
          else headers.set(String(k), String(v));
        }
      },
    };
  },

  async delete(key) {
    delete index[key];
    await saveIndex();
    try {
      await rm(blobPath(key));
    } catch {
      // Already gone — nothing to clean up.
    }
  },

  async *list({ prefix = "" } = {}) {
    for (const key of Object.keys(index)
      .filter((k) => k.startsWith(prefix))
      .sort()) {
      const meta = index[key];
      yield {
        key,
        size: meta.size,
        uploaded: new Date(meta.uploaded),
        httpMetadata: meta.httpMetadata,
        customMetadata: meta.customMetadata,
      };
    }
  },
};

// ============================================================
//  Static assets (public/)
// ============================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function assetsFetch(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const candidates = [pathname];
  if (!extname(pathname)) candidates.push(pathname + ".html");

  for (const candidate of candidates) {
    const filePath = normalize(join(PUBLIC_DIR, candidate));
    if (!filePath.startsWith(PUBLIC_DIR)) continue;
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const body = await readFile(filePath);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
        },
      });
    }
  }
  return new Response("Not found", { status: 404 });
}

// ============================================================
//  Mock OIDC provider (mounted on the same origin at /oidc)
// ============================================================

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: "dev-key",
  alg: "RS256",
  use: "sig",
};

/** Pending authorization codes: code -> { user, codeChallenge, redirectUri, returnTo } */
const pendingCodes = new Map();

function base64Url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function s256(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Browsable sign-in page. Lets a human pick an account and continue. */
function signInPage(params) {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, "&quot;")}">`)
    .join("");

  const cards = ACCOUNTS.map(
    (a) => `
      <label class="acct">
        <input type="radio" name="account" value="${a.sub}" ${
          a.sub === ACCOUNTS[0].sub ? "checked" : ""
        }>
        <span class="acct-body">
          <strong>${a.name}</strong>
          <em>${a.role}</em>
          <small>${a.email}</small>
        </span>
      </label>`
  ).join("");

  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Life Skills Committee</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font-family: Georgia, "Times New Roman", serif;
    background: linear-gradient(160deg, #fbf6ee 0%, #f3e7d7 100%);
    color: #3a2f24; padding: 24px;
  }
  .card {
    width: min(440px, 100%); background: #fffdf9; border: 1px solid #e3d5c2;
    border-radius: 14px; padding: 32px; box-shadow: 0 12px 34px rgba(90,70,45,.10);
  }
  h1 { margin: 0 0 4px; font-size: 1.5rem; letter-spacing: .2px; }
  .sub { margin: 0 0 22px; color: #7c6a55; font-size: .92rem; }
  .acct {
    display: flex; gap: 12px; align-items: center; padding: 12px; margin-bottom: 10px;
    border: 1px solid #e8dcc9; border-radius: 10px; cursor: pointer; background: #fff;
    transition: border-color .15s, background .15s;
  }
  .acct:hover { border-color: #c8a878; background: #fffaf2; }
  .acct:has(input:checked) { border-color: #a9773f; background: #fdf3e4; }
  .acct input { accent-color: #a9773f; width: 16px; height: 16px; }
  .acct-body { display: flex; flex-direction: column; gap: 2px; }
  .acct-body strong { font-size: 1rem; }
  .acct-body em { font-style: normal; color: #a9773f; font-size: .78rem; text-transform: uppercase; letter-spacing: .6px; }
  .acct-body small { color: #8b7a66; font-size: .82rem; }
  button {
    width: 100%; margin-top: 18px; padding: 12px; border: 0; border-radius: 10px;
    background: #a9773f; color: #fff; font: inherit; font-size: 1rem; cursor: pointer;
  }
  button:hover { background: #8f6232; }
  .note { margin: 16px 0 0; font-size: .78rem; color: #9a8874; text-align: center; }
</style>
</head>
<body>
  <form class="card" method="post" action="/oidc/approve">
    ${hidden}
    <h1>Sign in with Freebuff</h1>
    <p class="sub">Life Skills Committee is requesting your name and email address.</p>
    ${cards}
    <button type="submit">Continue</button>
    <p class="note">Local development server — accounts are simulated.</p>
  </form>
</body>
</html>`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function handleOidc(req, res, url, appOrigin) {
  // ---- JWKS ----
  if (req.method === "GET" && url.pathname === "/oidc/jwks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return true;
  }

  // ---- Authorization endpoint: show the sign-in page ----
  if (req.method === "GET" && url.pathname === "/oidc/authorize") {
    const params = Object.fromEntries(url.searchParams.entries());
    if (params.client_id !== CLIENT_ID || params.code_challenge_method !== "S256") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("unsupported authorize request");
      return true;
    }
    const page = signInPage(params);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(await page.text());
    return true;
  }

  // ---- Consent: issue a code and bounce back to the worker's callback ----
  if (req.method === "POST" && url.pathname === "/oidc/approve") {
    const form = new URLSearchParams(await readBody(req));
    const user = ACCOUNTS.find((a) => a.sub === form.get("account")) || ACCOUNTS[0];
    const code = base64Url(crypto.getRandomValues(new Uint8Array(24)));

    pendingCodes.set(code, {
      user,
      codeChallenge: form.get("code_challenge"),
      redirectUri: form.get("redirect_uri"),
      returnTo: form.get("returnTo") || "/",
      state: form.get("state"),
    });

    const back = new URL(form.get("redirect_uri"));
    back.searchParams.set("code", code);
    back.searchParams.set("state", form.get("state") || "");
    back.searchParams.set("returnTo", form.get("returnTo") || "/");

    res.writeHead(302, { Location: back.href });
    res.end();
    return true;
  }

  // ---- Token endpoint: verify PKCE, mint an RS256 id_token ----
  if (req.method === "POST" && url.pathname === "/oidc/token") {
    const form = new URLSearchParams(await readBody(req));
    const record = pendingCodes.get(form.get("code"));
    if (!record || !form.get("code_verifier")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return true;
    }
    if (s256(form.get("code_verifier")) !== record.codeChallenge) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE mismatch" }));
      return true;
    }
    pendingCodes.delete(form.get("code"));

    const idToken = await new SignJWT({
      email: record.user.email,
      name: record.user.name,
      role: record.user.role,
    })
      .setProtectedHeader({ alg: "RS256", kid: "dev-key" })
      .setIssuer(appOrigin + "/oidc")
      .setAudience(CLIENT_ID)
      .setSubject(record.user.sub)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id_token: idToken, token_type: "Bearer", expires_in: 3600 }));
    return true;
  }

  return false;
}

// ============================================================
//  HTTP server: /oidc/* -> mock provider, everything else -> worker
// ============================================================

const { default: worker } = await import(pathToFileURL(join(ROOT, "src", "worker.js")).href);

/** Drop `Secure` so cookies work over plain http://localhost. */
function rewriteSetCookie(values, isHttps) {
  if (isHttps) return values;
  return values.map((v) => v.replace(/;\s*Secure/gi, ""));
}

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    // Derive the app origin from the Host header so cookies, redirect_uri and
    // same-origin checks all match whatever hostname the browser is using.
    const appOrigin = `http://${host}`;
    const url = new URL(req.url, appOrigin);

    if (url.pathname.startsWith("/oidc/")) {
      if (await handleOidc(req, res, url, appOrigin)) return;
    }

    // ---- Build a Fetch API Request for the worker ----
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else headers.set(k, v);
    }

    const method = (req.method || "GET").toUpperCase();
    const init = { method, headers, redirect: "manual" };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(req);
      init.duplex = "half";
    }

    const request = new Request(url.href, init);
    const env = {
      FREEBUFF_ISSUER: appOrigin + "/oidc",
      FREEBUFF_CLIENT_ID: CLIENT_ID,
      APP_ORIGIN: appOrigin,
      // Only the two committee leaders may manage content locally. The
      // "Committee Member" account exists to demonstrate that a non-admin
      // signed-in user is refused.
      ADMIN_EMAILS: process.env.ADMIN_EMAILS || "joanna@example.com,natasha@example.com",
      ASSETS: { fetch: assetsFetch },
      VIDEOS: bucket,
    };

    const response = await worker.fetch(request, env, {});

    const out = { Status: response.status };
    const setCookies =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      out[key] = value;
    });
    const rewritten = rewriteSetCookie(setCookies, url.protocol === "https:");
    if (rewritten.length) out["Set-Cookie"] = rewritten;

    res.writeHead(response.status, out);

    if (method === "HEAD" || !response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    console.error("[dev-server] request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end("Internal dev server error: " + (err?.message || err));
  }
});

await mkdir(OBJECTS_DIR, { recursive: true });

server.listen(PORT, () => {
  const { port } = server.address();
  const stored = Object.keys(index).length;
  console.log("");
  console.log("  Life Skills Committee — local dev server");
  console.log("  ─────────────────────────────────────────");
  console.log(`  Site        http://localhost:${port}`);
  console.log(`  Admin       http://localhost:${port}/admin`);
  console.log(`  Sign-in     simulated accounts at /oidc/authorize`);
  console.log(`  Storage     .dev-data/ (${stored} object${stored === 1 ? "" : "s"} on disk)`);
  console.log("");
  console.log("  Stop with Ctrl+C");
  console.log("");
});
