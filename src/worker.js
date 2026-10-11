/**
 * Life Skills Committee — Cloudflare Worker
 *
 * Env vars (injected on deploy by sites_deploy):
 *   FREEBUFF_CLIENT_ID, FREEBUFF_ISSUER, APP_ORIGIN
 *   ASSETS  — static asset binding
 *   VIDEOS  — R2 bucket binding (holds videos/, links/ and images/)
 *
 * Sign in with Freebuff (OIDC + PKCE, no client secret):
 *   - /auth/freebuff/signin?returnTo=<path>    — start login
 *   - /auth/freebuff/callback                  — OIDC callback
 *   - /auth/freebuff/logout                    — end session
 *   - /auth/freebuff/session                   — GET current session
 *
 * The session cookie is __session (HttpOnly). getSession() verifies it
 * against the issuer's JWKS with jose.
 */

const COOKIE_NAME = "__session";
const STATE_COOKIE = "freebuff_state";
const CALLBACK_PATH = "/auth/freebuff/callback";
const SESSION_PATH = "/auth/freebuff/session";
const LOGOUT_PATH = "/auth/freebuff/logout";
const SIGNIN_PATH = "/auth/freebuff/signin";

// Upload caps. Workers buffered request bodies have a ~100 MB limit on
// hosted plans; keep headroom for multipart overhead.
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Only accounts listed here may upload or delete content. Comma-separated
// emails read from the ADMIN_EMAILS env var.
function adminEmails(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isAdmin(session, env) {
  const emails = adminEmails(env);
  // If no admin emails are configured, allow any authenticated user (so
  // deployments work out of the box; set ADMIN_EMAILS to restrict access).
  if (emails.length === 0) return true;
  return emails.includes(String(session?.email || "").toLowerCase());
}

// Upload extension allowlists. The client-declared MIME type is untrusted, so
// the content type we serve is derived from a validated extension instead.
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif"]);

function safeExtension(originalName) {
  const ext = originalName.includes(".")
    ? originalName.split(".").pop().toLowerCase()
    : "";
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
  "frame-src https://www.youtube-nocookie.com",
  "connect-src 'self'",
].join("; ");

/** Baseline hardening headers applied to every response. */
function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (!headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================
//  Helpers
// ============================================================

function json(body, status = 200, extraHeaders = {}) {
  const headers = new Headers({ "Content-Type": "application/json", ...extraHeaders });
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(url, status = 302, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Location", url);
  return new Response(null, { status, headers });
}

function getCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function publicUrl(key, appOrigin) {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return new URL("/" + encoded, appOrigin).href;
}

/** Plain http(s) check + normalization for user-supplied links. */
function cleanHttpUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Reject cross-origin mutations (CSRF hardening). */
function isSameOriginRequest(request, appOrigin) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("Origin");
  if (!origin) return true; // same-origin fetches may omit Origin; not a browser cross-site request
  try {
    return new URL(origin).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

// ============================================================
//  Auth
// ============================================================

function normalizeIssuer(issuer) {
  return String(issuer).replace(/\/+$/, "");
}

function issuerUrl(issuer, path) {
  return normalizeIssuer(issuer) + path;
}

// Module-scope JWKS cache is safe (no env access at module scope; keyed by URL).
let jwksCache = { url: null, promise: null };

function getJwks(issuer) {
  const url = issuerUrl(issuer, "/jwks");
  if (jwksCache.url !== url) {
    jwksCache = {
      url,
      promise: import("jose").then(({ createRemoteJWKSet }) =>
        createRemoteJWKSet(new URL(url))
      ),
    };
  }
  return jwksCache.promise;
}

async function verifyIdToken(token, clientId, issuer) {
  const { jwtVerify } = await import("jose");
  const keySet = await getJwks(issuer);
  const { payload } = await jwtVerify(token, keySet, {
    issuer: normalizeIssuer(issuer),
    audience: clientId,
  });
  return payload;
}

async function getSession(request, clientId, issuer) {
  const token = getCookie(request, COOKIE_NAME);
  if (!token) return null;
  try {
    return await verifyIdToken(token, clientId, issuer);
  } catch {
    return null;
  }
}

async function handleSignin(request, clientId, issuer, appOrigin) {
  const url = new URL(request.url);
  const rawReturnTo = url.searchParams.get("returnTo") || "/";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";
  const verifier = randomBase64Url(32);
  const challenge = await pkceChallenge(verifier);
  const state = randomBase64Url(16);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: appOrigin + CALLBACK_PATH,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    returnTo,
  });
  const authorizeUrl = issuerUrl(issuer, "/authorize") + "?" + params.toString();

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${STATE_COOKIE}=${state}:${verifier}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  headers.set("Cache-Control", "no-store");
  return redirect(authorizeUrl, 302, headers);
}

async function handleCallback(request, clientId, issuer, appOrigin) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const rawReturnTo = url.searchParams.get("returnTo") || "/";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";

  if (!code || !state) {
    return json({ error: "Missing code or state" }, 400);
  }

  const stateCookie = getCookie(request, STATE_COOKIE);
  const [cookieState, verifier] = (stateCookie || "").split(":");
  if (!stateCookie || cookieState !== state || !verifier) {
    return json({ error: "Invalid or expired sign-in state. Please try again." }, 400);
  }

  try {
    const tokenResponse = await fetch(issuerUrl(issuer, "/token"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: appOrigin + CALLBACK_PATH,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    if (!tokenResponse.ok) {
      return json({ error: "Token exchange failed" }, 502);
    }
    const tokens = await tokenResponse.json();
    const idToken = tokens.id_token;
    if (!idToken) {
      return json({ error: "No id_token in token response" }, 502);
    }

    await verifyIdToken(idToken, clientId, issuer);

    const headers = new Headers();
    headers.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${idToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`
    );
    headers.append(
      "Set-Cookie",
      `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    );
    headers.set("Cache-Control", "no-store");
    return redirect(returnTo, 302, headers);
  } catch (err) {
    return json({ error: "Sign-in failed: " + (err?.message || "unknown error") }, 400);
  }
}

function handleLogout(request) {
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
  headers.set("Cache-Control", "no-store");
  const rawReturnTo = new URL(request.url).searchParams.get("returnTo") || "/";
  const returnTo =
    rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//") ? rawReturnTo : "/";
  return redirect(returnTo, 302, headers);
}

async function handleSession(request, clientId, issuer) {
  const session = await getSession(request, clientId, issuer);
  if (!session) {
    return json({ user: null }, 200, { "Cache-Control": "no-store" });
  }
  return json(
    {
      user: {
        sub: session.sub,
        email: session.email,
        name: session.name,
        picture: session.picture,
      },
    },
    200,
    { "Cache-Control": "private, no-store" }
  );
}

function randomBase64Url(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ============================================================
//  Media: upload / list / delete / stream
// ============================================================

async function parseForm(request) {
  const formData = await request.formData();
  const fields = {};
  const files = [];
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      files.push({ key, name: value.name, type: value.type, body: value, size: value.size });
    } else {
      fields[key] = value;
    }
  }
  return { fields, files };
}

async function storeInR2(bucket, prefix, ext, body, contentType, customMetadata) {
  const slug = crypto.randomUUID().slice(0, 8);
  const key = `${prefix}${slug}.${ext}`;
  await bucket.put(key, body, { httpMetadata: { contentType }, customMetadata });
  return key;
}

async function handleUploadVideo(request, env, appOrigin) {
  const { fields, files } = await parseForm(request);
  const videoFile = files.find((f) => f.key === "video");
  const category = String(fields["category"] || "General").trim() || "General";

  if (!videoFile) return json({ error: "No video file provided" }, 400);
  if (!videoFile.type.startsWith("video/"))
    return json({ error: "That file is not a video" }, 400);
  if (videoFile.size > MAX_VIDEO_BYTES)
    return json(
      {
        error:
          "Video is larger than the 80 MB upload limit. Use “Add a Video by Link” for big files.",
      },
      413
    );

  // The client-declared MIME type is untrusted. Validate the extension and
  // derive the stored content type from it, so a file can never be stored and
  // later served as something a browser would execute (e.g. HTML).
  const ext = safeExtension(videoFile.name);
  if (!VIDEO_EXTENSIONS.has(ext))
    return json(
      {
        error: `Unsupported video file type. Allowed: ${[...VIDEO_EXTENSIONS].join(
          ", "
        )}`,
      },
      415
    );

  const key = await storeInR2(
    env.VIDEOS,
    "videos/",
    ext,
    videoFile.body,
    ext === "webm" ? "video/webm" : "video/mp4",
    { category, filename: videoFile.name }
  );

  return json({
    success: true,
    key,
    category,
    publicUrl: publicUrl(key, appOrigin),
    filename: videoFile.name,
  });
}

async function handleUploadImage(request, env, appOrigin) {
  const { fields, files } = await parseForm(request);
  const imageFile = files.find((f) => f.key === "image");
  const type = String(fields["type"] || "head").trim() || "head";

  if (!imageFile) return json({ error: "No image file provided" }, 400);
  if (!imageFile.type.startsWith("image/"))
    return json({ error: "That file is not an image" }, 400);
  if (imageFile.size > MAX_IMAGE_BYTES)
    return json({ error: "Image is larger than the 10 MB limit" }, 413);

  const ext = safeExtension(imageFile.name);
  if (!IMAGE_EXTENSIONS.has(ext))
    return json(
      {
        error: `Unsupported image file type. Allowed: ${[...IMAGE_EXTENSIONS].join(
          ", "
        )}`,
      },
      415
    );

  const key = await storeInR2(
    env.VIDEOS,
    "images/",
    ext,
    imageFile.body,
    `image/${ext === "jpg" ? "jpeg" : ext}`,
    { type, filename: imageFile.name }
  );

  return json({
    success: true,
    key,
    type,
    publicUrl: publicUrl(key, appOrigin),
    filename: imageFile.name,
  });
}

async function handleAddVideoLink(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const videoUrl = cleanHttpUrl(body.url);
  const title = String(body.title || "").trim();
  const category = String(body.category || "General").trim() || "General";

  if (!videoUrl) return json({ error: "Please provide a valid http(s) video URL" }, 400);
  if (!title) return json({ error: "Please provide a title for the video" }, 400);

  const key = `videos/links/${crypto.randomUUID().slice(0, 8)}.json`;
  const record = {
    url: videoUrl,
    title,
    category,
    addedAt: new Date().toISOString(),
  };
  await env.VIDEOS.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { category, kind: "link" },
  });

  return json({ success: true, key, ...record });
}

async function handleListVideos(env, appOrigin) {
  const entries = [];
  for await (const entry of env.VIDEOS.list({ prefix: "videos/" })) {
    const meta = entry.customMetadata || {};
    const addedAt = entry.uploaded ? entry.uploaded.toISOString() : "";

    if (entry.key.endsWith(".json")) {
      // External link record (YouTube / direct URL)
      try {
        const object = await env.VIDEOS.get(entry.key);
        if (!object) continue;
        const record = await object.json();
        const url = cleanHttpUrl(record.url);
        if (!url) continue;
        entries.push({
          key: entry.key,
          filename: record.title || entry.key.split("/").pop(),
          category: record.category || meta.category || "General",
          size: 0,
          external: true,
          url,
          addedAt: record.addedAt || addedAt,
        });
      } catch {
        // Skip unreadable link records rather than failing the whole list.
      }
    } else {
      entries.push({
        key: entry.key,
        filename: meta.filename || entry.key.replace(/^videos\//, ""),
        category: meta.category || "General",
        size: entry.size,
        external: false,
        url: publicUrl(entry.key, appOrigin),
        addedAt,
      });
    }
  }
  entries.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  return json(entries);
}

async function handleListImages(env, appOrigin) {
  const entries = [];
  for await (const entry of env.VIDEOS.list({ prefix: "images/" })) {
    const meta = entry.customMetadata || {};
    entries.push({
      key: entry.key,
      filename: meta.filename || entry.key.replace(/^images\//, ""),
      type: meta.type || "head",
      url: publicUrl(entry.key, appOrigin),
      addedAt: entry.uploaded ? entry.uploaded.toISOString() : "",
    });
  }
  entries.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  return json(entries);
}

function normalizeKey(rawPath) {
  // "/videos/abc.mp4" -> "videos/abc.mp4"
  const key = decodeURIComponent(rawPath).replace(/^\/+/, "");
  // R2 keys are literal so ".." cannot traverse, but reject it outright rather
  // than relying on that property.
  if (key.includes("..")) return null;
  return key;
}

async function handleDeleteMedia(env, rawKey, requiredPrefix) {
  let key;
  try {
    key = decodeURIComponent(rawKey).replace(/^\/+/, "");
  } catch {
    return json({ error: "Malformed key" }, 400);
  }
  if (!key) return json({ error: "Missing key" }, 400);

  // Confine deletes to the namespace implied by the route, so one endpoint
  // cannot reach into the other's objects (or anywhere else in the bucket).
  if (requiredPrefix) {
    if (key.includes("..") || !key.startsWith(requiredPrefix)) {
      return json({ error: "Invalid key" }, 400);
    }
  }

  await env.VIDEOS.delete(key);
  return json({ success: true });
}

async function streamFromR2(request, bucket, key, fallbackType) {
  try {
    const normalized = normalizeKey(key);
    if (!normalized) return new Response("Not found", { status: 404 });

    const rangeHeader = request.headers.get("Range");
    const opts = rangeHeader ? { range: request.headers } : undefined;
    const object = await bucket.get(normalized, opts);
    if (!object) return new Response("Not found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.get("Content-Type")) headers.set("Content-Type", fallbackType);
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=3600");

    let status = 200;
    if (object.range && typeof object.range.offset === "number") {
      const start = object.range.offset;
      const end =
        typeof object.range.length === "number"
          ? start + object.range.length - 1
          : object.size - 1;
      headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
      status = 206;
    }

    if (request.method === "HEAD") {
      if (status === 200) headers.set("Content-Length", String(object.size));
      return new Response(null, { status, headers });
    }

    return new Response(object.body, { status, headers });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// ============================================================
//  Main fetch handler
// ============================================================

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const issuer = env.FREEBUFF_ISSUER;
  const clientId = env.FREEBUFF_CLIENT_ID;
  const appOrigin = env.APP_ORIGIN;

  // ---- Auth routes ----
  if (url.pathname.startsWith("/auth/freebuff")) {
    if (url.pathname === CALLBACK_PATH && request.method === "GET") {
      return handleCallback(request, clientId, issuer, appOrigin);
    }
    if (url.pathname === SESSION_PATH && request.method === "GET") {
      return handleSession(request, clientId, issuer);
    }
    if (url.pathname === LOGOUT_PATH && request.method === "POST") {
      if (!isSameOriginRequest(request, appOrigin)) return json({ error: "Forbidden" }, 403);
      return handleLogout(request);
    }
    if (url.pathname === SIGNIN_PATH && request.method === "GET") {
      return handleSignin(request, clientId, issuer, appOrigin);
    }
    if (request.method === "GET") {
      return handleSignin(request, clientId, issuer, appOrigin);
    }
    return json({ error: "Not found" }, 404);
  }

  // ---- API routes ----
  // Reads of the media lists are public (the Video Library and Heads & Mistress
  // pages are visitor-facing). /api/auth/user needs a session. Everything that
  // mutates content additionally requires an admin account.
  const PUBLIC_GETS = new Set(["/api/videos", "/api/images"]);
  const isPublicRead = PUBLIC_GETS.has(url.pathname) && request.method === "GET";

  // Routes that change stored content — admin-only.
  const path = url.pathname;
  const isAdminOnly =
    (path === "/api/upload/video" && request.method === "POST") ||
    (path === "/api/upload/image" && request.method === "POST") ||
    (path === "/api/videos/link" && request.method === "POST") ||
    (path.startsWith("/api/videos/") && request.method === "DELETE") ||
    (path.startsWith("/api/images/") && request.method === "DELETE");

  let session = null;
  if (url.pathname.startsWith("/api/")) {
    if (!isPublicRead) {
      session = await getSession(request, clientId, issuer);
      if (!session) {
        return json({ error: "Unauthorized" }, 401, { "Cache-Control": "no-store" });
      }
      if (!isSameOriginRequest(request, appOrigin)) {
        return json({ error: "Forbidden" }, 403);
      }
    }

    if (isAdminOnly && !isAdmin(session, env)) {
      return json(
        { error: "Forbidden — admin access required" },
        403,
        { "Cache-Control": "no-store" }
      );
    }

    // The public read routes share the handlers below, so re-read the
    // session only where a route actually needs it.
    if (url.pathname === "/api/auth/user" && request.method === "GET") {
      const session = await getSession(request, clientId, issuer);
      if (!session) {
        return json({ error: "Unauthorized" }, 401, { "Cache-Control": "no-store" });
      }
      return json(
        { sub: session.sub, email: session.email, name: session.name },
        200,
        { "Cache-Control": "private, no-store" }
      );
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request);
    }
    if (url.pathname === "/api/upload/video" && request.method === "POST") {
      return handleUploadVideo(request, env, appOrigin);
    }
    if (url.pathname === "/api/upload/image" && request.method === "POST") {
      return handleUploadImage(request, env, appOrigin);
    }
    if (url.pathname === "/api/videos/link" && request.method === "POST") {
      return handleAddVideoLink(request, env);
    }
    if (url.pathname === "/api/videos" && request.method === "GET") {
      return handleListVideos(env, appOrigin);
    }
    if (url.pathname === "/api/images" && request.method === "GET") {
      return handleListImages(env, appOrigin);
    }
    if (url.pathname.startsWith("/api/videos/") && request.method === "DELETE") {
      return handleDeleteMedia(
        env,
        url.pathname.slice("/api/videos/".length),
        "videos/"
      );
    }
    if (url.pathname.startsWith("/api/images/") && request.method === "DELETE") {
      return handleDeleteMedia(
        env,
        url.pathname.slice("/api/images/".length),
        "images/"
      );
    }
    return json({ error: "Not found" }, 404);
  }

  // ---- Public media streaming ----
  if (url.pathname.startsWith("/videos/")) {
    return streamFromR2(request, env.VIDEOS, url.pathname, "video/mp4");
  }
  if (url.pathname.startsWith("/images/")) {
    return streamFromR2(request, env.VIDEOS, url.pathname, "image/jpeg");
  }

  // ---- Static frontend ----
  try {
    return await env.ASSETS.fetch(request);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// Every response passes through here so the baseline hardening headers can
// never be forgotten on a new route.
export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await handleRequest(request, env, ctx));
  },
};
