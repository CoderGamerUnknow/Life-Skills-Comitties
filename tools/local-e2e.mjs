/**
 * Local end-to-end test for the Life Skills Committee worker.
 *
 * Runs src/worker.js against fakes:
 *   - a mock OIDC provider (JWKS + token endpoint) with a real RS256 keypair
 *   - an in-memory R2 bucket (put/get/list/delete + range reads)
 *   - a static asset server backed by public/
 *
 * Covers: signin redirect + state cookie, callback + session cookie,
 * session verification, upload, list, streaming (+ Range), link videos,
 * deletes, auth guards, cross-origin rejection, static pages.
 *
 * Usage: node tools/local-e2e.mjs
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const CLIENT_ID = "test-client";
const APP_ORIGIN = "http://app.local";

// ------------------------------------------------------------
// Mock OIDC provider
// ------------------------------------------------------------

const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const publicJwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

const provider = createServer(async (req, res) => {
  const url = new URL(req.url, "http://provider.local");
  if (req.method === "GET" && url.pathname === "/oidc/jwks") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/oidc/token") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const params = new URLSearchParams(raw);
    if (!params.get("code_verifier")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: "no PKCE verifier" }));
      return;
    }
    const issuer = `http://127.0.0.1:${provider.address().port}/oidc`;
    const idToken = await new SignJWT({
      email: "joanna@example.com",
      name: "Joanna",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience(CLIENT_ID)
      .setSubject("user-123")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id_token: idToken, token_type: "Bearer", expires_in: 3600 }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const ISSUER = `http://127.0.0.1:${provider.address().port}/oidc`;

// ------------------------------------------------------------
// In-memory R2 bucket
// ------------------------------------------------------------

function makeR2Bucket() {
  const store = new Map();

  function parseRange(header, size) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(header || "").trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : size - 1;
    if (start >= size) return null;
    return { offset: start, length: Math.min(end, size - 1) - start + 1 };
  }

  return {
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
      store.set(key, {
        buf,
        httpMetadata: opts.httpMetadata || {},
        customMetadata: opts.customMetadata || {},
        uploaded: new Date(),
      });
    },

    async get(key, opts = {}) {
      const rec = store.get(key);
      if (!rec) return null;
      const rangeHeader =
        opts.range && typeof opts.range.get === "function"
          ? opts.range.get("range")
          : null;
      const range = rangeHeader ? parseRange(rangeHeader, rec.buf.length) : null;
      const buf = range ? rec.buf.subarray(range.offset, range.offset + range.length) : rec.buf;
      return {
        key,
        size: rec.buf.length,
        etag: "test-etag",
        httpEtag: '"test-etag"',
        httpMetadata: rec.httpMetadata,
        customMetadata: rec.customMetadata,
        range: range || undefined,
        body: new Blob([buf]).stream(),
        // R2ObjectBody mixin methods
        async text() {
          return buf.toString("utf8");
        },
        async json() {
          return JSON.parse(buf.toString("utf8"));
        },
        async arrayBuffer() {
          return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        },
        writeHttpMetadata(headers) {
          for (const [k, v] of Object.entries(rec.httpMetadata)) {
            if (v == null) continue;
            if (k === "contentType") headers.set("Content-Type", String(v));
            else headers.set(String(k), String(v));
          }
        },
      };
    },

    async delete(key) {
      store.delete(key);
    },

    async *list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      for (const key of keys) {
        const rec = store.get(key);
        yield {
          key,
          size: rec.buf.length,
          uploaded: rec.uploaded,
          httpMetadata: rec.httpMetadata,
          customMetadata: rec.customMetadata,
        };
      }
    },

    /** Test-only peek. */
    raw(key) {
      return store.get(key);
    },
  };
}

// ------------------------------------------------------------
// Static asset fake (public/)
// ------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

async function assetsFetch(request) {
  const url = new URL(request.url);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const candidates = [pathname];
  if (!extname(pathname)) candidates.push(pathname + ".html");

  for (const candidate of candidates) {
    const filePath = normalize(join(PUBLIC_DIR, candidate));
    if (!filePath.startsWith(PUBLIC_DIR)) continue;
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const body = await readFile(filePath);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" },
      });
    }
  }
  return new Response("Not found", { status: 404 });
}

// ------------------------------------------------------------
// Test runner
// ------------------------------------------------------------

// Pass a path to test a build output, e.g.: node tools/local-e2e.mjs dist/worker.js
const workerPath = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(ROOT, "src", "worker.js");
const { default: worker } = await import(pathToFileURL(workerPath).href);
console.log(`Worker under test: ${workerPath}`);

const env = {
  FREEBUFF_ISSUER: ISSUER,
  FREEBUFF_CLIENT_ID: CLIENT_ID,
  APP_ORIGIN,
  ASSETS: { fetch: assetsFetch },
  VIDEOS: makeR2Bucket(),
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
}

async function call(path, options = {}) {
  const req = new Request(APP_ORIGIN + path, options);
  return worker.fetch(req, env, {});
}

function cookieValue(setCookie) {
  // returns value of first name=value pair
  if (!setCookie) return null;
  return setCookie.split(";")[0].split("=").slice(1).join("=");
}

console.log("\n— Static pages —");
{
  const home = await call("/");
  const homeBody = await home.text();
  check("GET / → 200", home.status === 200, `status ${home.status}`);
  check("home has committee title", homeBody.includes("Life Skills Committee"));
  check("home shows Head Joanna", homeBody.includes("Joanna"));
  check("home shows Mrs Natasha Steve", homeBody.includes("Mrs Natasha Steve"));

  const about = await call("/about");
  check("GET /about → 200", about.status === 200, `status ${about.status}`);
  check("about has team grid", (await about.text()).includes("team-grid"));

  const admin = await call("/admin");
  const adminBody = await admin.text();
  check("GET /admin → 200", admin.status === 200, `status ${admin.status}`);
  check("admin has link form", adminBody.includes("link-form"));
  check("admin has sign-in button", adminBody.includes("sign-in-btn"));
  check("admin gates content", adminBody.includes("admin-content"));

  const members = await call("/members");
  check("GET /members → 200", members.status === 200, `status ${members.status}`);
}

console.log("\n— Auth guards —");
{
  const videos = await call("/api/videos");
  check("GET /api/videos unauthenticated → 401", videos.status === 401, `status ${videos.status}`);

  const user = await call("/api/auth/user");
  check("GET /api/auth/user unauthenticated → 401", user.status === 401, `status ${user.status}`);

  const session = await call("/auth/freebuff/session");
  const sessionBody = await session.json();
  check("GET /auth/freebuff/session → user null", session.status === 200 && sessionBody.user === null);
}

console.log("\n— Sign-in flow —");
let sessionCookie;
{
  const signin = await call("/auth/freebuff/signin?returnTo=/admin");
  const location = signin.headers.get("Location") || "";
  const setCookie = signin.headers.get("Set-Cookie") || "";
  check("signin → 302", signin.status === 302, `status ${signin.status}`);
  check(
    "signin redirects to issuer authorize endpoint",
    location.startsWith(ISSUER + "/authorize"),
    location
  );

  const authUrl = new URL(location);
  check("authorize has PKCE S256", authUrl.searchParams.get("code_challenge_method") === "S256");
  check("authorize has client_id", authUrl.searchParams.get("client_id") === CLIENT_ID);

  const state = authUrl.searchParams.get("state");
  const stateCookie = cookieValue(setCookie);
  const [cookieState, verifier] = (stateCookie || "").split(":");
  check("signin sets state cookie", !!stateCookie, setCookie || "missing Set-Cookie");
  check("state cookie matches state param", cookieState === state);
  check("state cookie carries PKCE verifier", !!verifier && verifier.length > 20);

  const { createHash } = await import("node:crypto");
  const expectedChallenge = createHash("sha256")
    .update(verifier || "")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  check(
    "code_challenge = S256(verifier)",
    authUrl.searchParams.get("code_challenge") === expectedChallenge
  );

  // Wrong state → rejected
  const bad = await call(
    `/auth/freebuff/callback?code=test-code&state=WRONG&returnTo=/admin`,
    { headers: { Cookie: `freebuff_state=${stateCookie}` } }
  );
  check("callback with wrong state → 400", bad.status === 400, `status ${bad.status}`);

  // Correct callback → token exchange with mock provider → session cookie
  const cb = await call(
    `/auth/freebuff/callback?code=test-code&state=${state}&returnTo=/admin`,
    { headers: { Cookie: `freebuff_state=${stateCookie}` } }
  );
  const cbCookies = cb.headers.getSetCookie ? cb.headers.getSetCookie() : [cb.headers.get("Set-Cookie")];
  const sessionSet = cbCookies.find((c) => c && c.startsWith("__session="));
  sessionCookie = sessionSet ? cookieValue(sessionSet) : null;
  check("callback → 302", cb.status === 302, `status ${cb.status}`);
  check("callback redirects to returnTo", cb.headers.get("Location") === "/admin");
  check("callback sets __session cookie", !!sessionCookie, "no __session Set-Cookie");
  check(
    "session cookie is HttpOnly + SameSite=Lax",
    !!sessionSet && /HttpOnly/i.test(sessionSet) && /SameSite=Lax/i.test(sessionSet)
  );

  // Session is now valid
  const me = await call("/api/auth/user", { headers: { Cookie: `__session=${sessionCookie}` } });
  const meBody = await me.json();
  check("GET /api/auth/user signed in → 200", me.status === 200, `status ${me.status}`);
  check("user email from id_token", meBody.email === "joanna@example.com", JSON.stringify(meBody));

  const sess = await call("/auth/freebuff/session", { headers: { Cookie: `__session=${sessionCookie}` } });
  const sessBody = await sess.json();
  check("session endpoint returns user", sess.status === 200 && sessBody.user?.sub === "user-123");
}

const authHeaders = { Cookie: `__session=${sessionCookie}` };

console.log("\n— Video upload —");
let videoKey;
{
  const bytes = new TextEncoder().encode("FAKE-VIDEO-BYTES-0123456789");
  const fd = new FormData();
  fd.append("video", new File([bytes], "lesson-one.mp4", { type: "video/mp4" }));
  fd.append("category", "Communication");

  const up = await call("/api/upload/video", { method: "POST", body: fd, headers: authHeaders });
  const upBody = await up.json();
  videoKey = upBody.key;
  check("upload video → 200", up.status === 200, `status ${up.status} ${JSON.stringify(upBody)}`);
  check("upload returns R2 key", typeof videoKey === "string" && videoKey.startsWith("videos/"), videoKey);
  check("upload category kept", upBody.category === "Communication");
  check(
    "publicUrl points at /videos/",
    typeof upBody.publicUrl === "string" && upBody.publicUrl.startsWith(APP_ORIGIN + "/videos/"),
    upBody.publicUrl
  );

  const stored = env.VIDEOS.raw(videoKey);
  check("object stored in R2", !!stored);
  check("R2 customMetadata.category stored", stored?.customMetadata?.category === "Communication");
  check("R2 content type stored", stored?.httpMetadata?.contentType === "video/mp4");

  const list = await call("/api/videos", { headers: authHeaders });
  const listBody = await list.json();
  check("GET /api/videos → 200", list.status === 200, `status ${list.status}`);
  check("list contains uploaded video", Array.isArray(listBody) && listBody.some((v) => v.key === videoKey));
  const entry = listBody.find((v) => v.key === videoKey);
  check("list entry has filename", entry?.filename === "lesson-one.mp4", JSON.stringify(entry));
  check("list entry has category", entry?.category === "Communication");
  check("list entry external=false", entry?.external === false);
}

console.log("\n— Streaming —");
{
  const res = await call("/videos/" + videoKey.replace(/^videos\//, ""));
  const body = Buffer.from(await res.arrayBuffer());
  check("GET /videos/<key> → 200", res.status === 200, `status ${res.status}`);
  check("streams video bytes", body.toString().includes("FAKE-VIDEO-BYTES"), body.toString());
  check("stream content-type video/mp4", res.headers.get("Content-Type") === "video/mp4");

  const ranged = await call("/videos/" + videoKey.replace(/^videos\//, ""), {
    headers: { Range: "bytes=5-9" },
  });
  const rangeBody = Buffer.from(await ranged.arrayBuffer());
  check("Range request → 206", ranged.status === 206, `status ${ranged.status}`);
  check(
    "Content-Range header correct",
    ranged.headers.get("Content-Range") === "bytes 5-9/27",
    ranged.headers.get("Content-Range") || "missing"
  );
  check("range body is the slice", rangeBody.toString() === "VIDEO", rangeBody.toString());
}

console.log("\n— Add by link —");
let linkKey;
{
  const add = await call("/api/videos/link", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Session 1 — Communication",
      category: "Communication",
      url: "https://youtu.be/abc123xyz",
    }),
  });
  const addBody = await add.json();
  linkKey = addBody.key;
  check("add link → 200", add.status === 200, `status ${add.status} ${JSON.stringify(addBody)}`);
  check("link key under videos/links/", typeof linkKey === "string" && linkKey.startsWith("videos/links/"), linkKey);

  const bad = await call("/api/videos/link", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Bad", category: "X", url: "javascript:alert(1)" }),
  });
  check("add link rejects bad URL → 400", bad.status === 400, `status ${bad.status}`);

  const noTitle = await call("/api/videos/link", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "  ", category: "X", url: "https://example.com/a.mp4" }),
  });
  check("add link rejects empty title → 400", noTitle.status === 400, `status ${noTitle.status}`);

  const list = await call("/api/videos", { headers: authHeaders });
  const listBody = await list.json();
  const entry = listBody.find((v) => v.key === linkKey);
  check("list contains link entry", !!entry, JSON.stringify(listBody));
  check("link entry external=true", entry?.external === true);
  check("link entry url preserved", entry?.url === "https://youtu.be/abc123xyz", entry?.url);
  check("link entry shows title", entry?.filename === "Session 1 — Communication");
}

console.log("\n— Image upload —");
let imageKey;
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
  const fd = new FormData();
  fd.append("image", new File([png], "joanna.png", { type: "image/png" }));
  fd.append("type", "head");

  const up = await call("/api/upload/image", { method: "POST", body: fd, headers: authHeaders });
  const upBody = await up.json();
  imageKey = upBody.key;
  check("upload image → 200", up.status === 200, `status ${up.status} ${JSON.stringify(upBody)}`);
  check("image key under images/", typeof imageKey === "string" && imageKey.startsWith("images/"), imageKey);

  const list = await call("/api/images", { headers: authHeaders });
  const listBody = await list.json();
  check("images list includes photo", listBody.some((i) => i.key === imageKey));
  check(
    "images list type=head",
    listBody.find((i) => i.key === imageKey)?.type === "head"
  );

  const res = await call("/images/" + imageKey.replace(/^images\//, ""));
  check("GET /images/<key> → 200", res.status === 200, `status ${res.status}`);
  check("image content-type png", res.headers.get("Content-Type") === "image/png");
}

console.log("\n— Security —");
{
  const cross = await call("/api/upload/video", {
    method: "POST",
    headers: { ...authHeaders, Origin: "https://evil.example" },
    body: (() => {
      const fd = new FormData();
      fd.append("video", new File([new Uint8Array(4)], "x.mp4", { type: "video/mp4" }));
      fd.append("category", "X");
      return fd;
    })(),
  });
  check("cross-origin upload → 403", cross.status === 403, `status ${cross.status}`);

  const crossLink = await call("/api/videos/link", {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ title: "X", category: "X", url: "https://example.com/a.mp4" }),
  });
  check("cross-origin link add → 403", crossLink.status === 403, `status ${crossLink.status}`);

  const notVideo = await call("/api/upload/video", {
    method: "POST",
    headers: authHeaders,
    body: (() => {
      const fd = new FormData();
      fd.append("video", new File([new Uint8Array(4)], "notes.txt", { type: "text/plain" }));
      fd.append("category", "X");
      return fd;
    })(),
  });
  check("non-video file rejected → 400", notVideo.status === 400, `status ${notVideo.status}`);
}

console.log("\n— Deletes —");
{
  const del = await call("/api/videos/" + encodeURIComponent(videoKey), {
    method: "DELETE",
    headers: authHeaders,
  });
  check("DELETE video → 200", del.status === 200, `status ${del.status}`);

  const gone = await call("/videos/" + videoKey.replace(/^videos\//, ""));
  check("deleted video 404s", gone.status === 404, `status ${gone.status}`);

  const delLink = await call("/api/videos/" + encodeURIComponent(linkKey), {
    method: "DELETE",
    headers: authHeaders,
  });
  check("DELETE link → 200", delLink.status === 200, `status ${delLink.status}`);

  const delImg = await call("/api/images/" + encodeURIComponent(imageKey), {
    method: "DELETE",
    headers: authHeaders,
  });
  check("DELETE image → 200", delImg.status === 200, `status ${delImg.status}`);

  const list = await call("/api/videos", { headers: authHeaders });
  const listBody = await list.json();
  check("video list empty after deletes", listBody.length === 0, JSON.stringify(listBody));
}

console.log("\n— Logout —");
{
  const out = await call("/auth/freebuff/logout", { method: "POST", headers: authHeaders });
  const setCookie = out.headers.get("Set-Cookie") || "";
  check("logout → 302", out.status === 302, `status ${out.status}`);
  check("logout clears cookie", /__session=;/.test(setCookie) && /Max-Age=0/.test(setCookie), setCookie);
}

console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailed checks:");
  for (const f of failures) console.log("  - " + f);
}

provider.close();
process.exit(failed === 0 ? 0 : 1);
