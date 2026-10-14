/**
 * Tests for the Vercel backend (lib/ + api/).
 *
 * Three layers:
 *   1. pure rules in lib/media.js and lib/auth.js — no server, no network;
 *   2. handler behaviour through tools/local-api-server.mjs (auth guards,
 *      method handling, empty-store responses);
 *   3. real-store integration — only when BLOB_READ_WRITE_TOKEN is available
 *      (from .env.local or the environment), because it talks to Vercel Blob
 *      for real: issue an upload token, prove a bogus finalize is rejected,
 *      write/list/delete a link video, then confirm it is gone.
 *
 * Usage: npm run test:api
 */

import { startServer, loadEnvFile } from "./local-api-server.mjs";
import {
  ID_PATTERN,
  cleanHttpUrl,
  cleanText,
  isExtensionAllowed,
  isId,
  mediaPathname,
  newId,
  parseMediaPathname,
  toPublicVideo,
} from "../lib/media.js";
import { issueSession, isSignedIn, passcodeMatches, requireAdmin } from "../lib/auth.js";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
await loadEnvFile(join(ROOT, ".env.local"));

// Keep the real token aside: the tests below flip the "store is connected" state.
const REAL_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
const PASSCODE = "let-me-in";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ============================================================
//  1. Pure rules
// ============================================================

section("lib/media.js");

const id = newId();
check("newId() is 32 hex characters", ID_PATTERN.test(id), id);
check("isId() accepts a generated id", isId(id));
check("isId() rejects a short id", !isId("abc"));
check("isId() rejects a path", !isId("videos/abc.mp4"));

check(
  "mediaPathname() lowercases the extension",
  mediaPathname("video", id, "MP4") === `videos/${id}.mp4`
);

const parsed = parseMediaPathname("video", `videos/${id}.mp4`);
check("parseMediaPathname() round-trips", parsed?.id === id && parsed?.extension === "mp4");
check("parseMediaPathname() accepts webm", !!parseMediaPathname("video", `videos/${id}.webm`));
check("parseMediaPathname() rejects other folders", !parseMediaPathname("video", `other/${id}.mp4`));
check("parseMediaPathname() rejects unknown extensions", !parseMediaPathname("video", `videos/${id}.exe`));
check("parseMediaPathname() rejects non-hex ids", !parseMediaPathname("video", "videos/nope.mp4"));
check(
  "parseMediaPathname() rejects traversal",
  !parseMediaPathname("video", `videos/../../secrets/${id}.mp4`)
);
check(
  "parseMediaPathname() rejects nested paths",
  !parseMediaPathname("video", `videos/${id}.mp4/extra`)
);
check("isExtensionAllowed() is case-insensitive", isExtensionAllowed("video", "MP4"));
check("isExtensionAllowed() rejects images", !isExtensionAllowed("video", "png"));

check("cleanText() collapses whitespace", cleanText("  Communication \n skills ", 60) === "Communication skills");
check("cleanText() caps the length", cleanText("x".repeat(120), 60).length === 60);
check("cleanText() tolerates undefined", cleanText(undefined, 10) === "");

check("cleanHttpUrl() keeps https", cleanHttpUrl("https://youtu.be/abc") === "https://youtu.be/abc");
check("cleanHttpUrl() keeps http", cleanHttpUrl("http://example.com/a.mp4") === "http://example.com/a.mp4");
check("cleanHttpUrl() rejects javascript:", cleanHttpUrl("javascript:alert(1)") === null);
check("cleanHttpUrl() rejects data:", cleanHttpUrl("data:text/html,<script>") === null);
check("cleanHttpUrl() rejects relative paths", cleanHttpUrl("/videos/abc.mp4") === null);

const fileRecord = {
  id,
  kind: "file",
  filename: "Session 1.mp4",
  category: "Communication",
  pathname: `videos/${id}.mp4`,
  url: `https://store.public.blob.vercel-storage.com/videos/${id}.mp4`,
  size: 1234,
  addedAt: "2026-10-12T10:00:00.000Z",
};
const linkRecord = {
  id,
  kind: "link",
  title: "Teamwork",
  category: "Teamwork",
  url: "https://www.youtube.com/watch?v=abc",
  size: 0,
  addedAt: "2026-10-12T11:00:00.000Z",
};

const publicFile = toPublicVideo(fileRecord);
check("toPublicVideo() exposes the key and filename", publicFile.key === id && publicFile.filename === "Session 1.mp4");
check("toPublicVideo() marks files as not external", publicFile.external === false && publicFile.size === 1234);

const publicLink = toPublicVideo(linkRecord);
check("toPublicVideo() uses the title for links", publicLink.filename === "Teamwork" && publicLink.external === true);
check("toPublicVideo() drops records without an id", toPublicVideo({ url: "https://x.test/a.mp4" }) === null);
check("toPublicVideo() drops records without a url", toPublicVideo({ ...fileRecord, url: "" }) === null);
check(
  "toPublicVideo() defaults a missing category",
  toPublicVideo({ ...fileRecord, category: undefined }).category === "General"
);

// ============================================================
//  2. Auth + handler behaviour
// ============================================================

section("lib/auth.js");

process.env.ADMIN_PASSWORD = PASSCODE;
check("passcodeMatches() accepts the passcode", await passcodeMatches(PASSCODE));
check("passcodeMatches() rejects a wrong passcode", !(await passcodeMatches("nope")));
check("passcodeMatches() rejects an empty passcode", !(await passcodeMatches("")));

const sessionToken = await issueSession();
const signedInRequest = new Request("https://app.test/api/auth-user", {
  headers: { Cookie: `__session=${sessionToken}` },
});
check("isSignedIn() accepts a fresh session", await isSignedIn(signedInRequest));
check(
  "isSignedIn() rejects a tampered signature",
  !(await isSignedIn(new Request("https://app.test/api/auth-user", {
    headers: { Cookie: `__session=${sessionToken.slice(0, -2)}ff` },
  })))
);
check(
  "isSignedIn() rejects an expired session",
  !(await isSignedIn(new Request("https://app.test/api/auth-user", {
    headers: { Cookie: "__session=1000000000000.deadbeef" },
  })))
);
check("isSignedIn() rejects a missing cookie", !(await isSignedIn(new Request("https://app.test/api/auth-user"))));

const crossOrigin = new Request("https://app.test/api/videos", {
  method: "POST",
  headers: { Origin: "https://evil.test", Host: "app.test", Cookie: `__session=${sessionToken}` },
  body: "{}",
});
check("requireAdmin() blocks cross-origin posts", (await requireAdmin(crossOrigin))?.status === 403);

delete process.env.ADMIN_PASSWORD;
check(
  "requireAdmin() explains a missing passcode",
  (await requireAdmin(signedInRequest))?.status === 503
);

section("api handlers (no blob store)");

// No store connected, passcode set: public reads must still render the site.
delete process.env.BLOB_READ_WRITE_TOKEN;
process.env.ADMIN_PASSWORD = PASSCODE;

const server = await startServer({ port: 0 });
const base = `http://localhost:${server.address().port}`;

const call = (path, options = {}) => fetch(base + path, options);
const jsonHeaders = { "Content-Type": "application/json" };

const videosEmpty = await call("/api/videos");
check("GET /api/videos → 200", videosEmpty.status === 200, `status ${videosEmpty.status}`);
check("GET /api/videos → [] before a store exists", JSON.stringify(await videosEmpty.json()) === "[]");

const freshVideos = await call("/api/videos?fresh=1");
check(
  "GET /api/videos?fresh=1 bypasses the cache",
  (freshVideos.headers.get("Cache-Control") || "") === "no-store"
);

const noSession = await call("/api/auth-user");
check("GET /api/auth-user without a session → 401", noSession.status === 401, `status ${noSession.status}`);

// A deployment that has not been configured yet should say so clearly.
delete process.env.ADMIN_PASSWORD;
const noPasscode = await call("/api/auth-user");
check("GET /api/auth-user without a passcode → 503", noPasscode.status === 503, `status ${noPasscode.status}`);
const setUpLogin = await call("/api/auth-login", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ password: "anything" }),
});
check("POST /api/auth-login without a passcode → 503", setUpLogin.status === 503, `status ${setUpLogin.status}`);
process.env.ADMIN_PASSWORD = PASSCODE;

const badLogin = await call("/api/auth-login", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ password: "wrong" }),
});
check("POST /api/auth-login with a wrong passcode → 401", badLogin.status === 401, `status ${badLogin.status}`);

const login = await call("/api/auth-login", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ password: PASSCODE }),
});
const setCookie = login.headers.get("set-cookie") || "";
check("POST /api/auth-login → 200", login.status === 200, `status ${login.status}`);
check("login sets an HttpOnly __session cookie", /__session=/.test(setCookie) && /HttpOnly/i.test(setCookie));
check("login cookie is SameSite=Lax", /SameSite=Lax/i.test(setCookie));
const cookie = setCookie.split(";")[0];

const me = await call("/api/auth-user", { headers: { Cookie: cookie } });
check("GET /api/auth-user with the cookie → 200", me.status === 200, `status ${me.status}`);

const anonymousUpsert = await call("/api/videos", {
  method: "POST",
  headers: jsonHeaders,
  body: JSON.stringify({ title: "x", category: "y", url: "https://youtu.be/abc" }),
});
check("POST /api/videos without a session → 401", anonymousUpsert.status === 401, `status ${anonymousUpsert.status}`);

const anonymousDelete = await call(`/api/videos?key=${id}`, { method: "DELETE" });
check("DELETE /api/videos without a session → 401", anonymousDelete.status === 401, `status ${anonymousDelete.status}`);

const crossSiteAdd = await call("/api/videos", {
  method: "POST",
  headers: { ...jsonHeaders, Cookie: cookie, Origin: "https://evil.test" },
  body: JSON.stringify({ title: "x", category: "y", url: "https://youtu.be/abc" }),
});
check("POST /api/videos from another origin → 403", crossSiteAdd.status === 403, `status ${crossSiteAdd.status}`);

const addWithoutStore = await call("/api/videos", {
  method: "POST",
  headers: { ...jsonHeaders, Cookie: cookie },
  body: JSON.stringify({ title: "Session 1", category: "Communication", url: "https://youtu.be/abc" }),
});
check("POST /api/videos explains a missing store → 503", addWithoutStore.status === 503, `status ${addWithoutStore.status}`);

const uploadAnonymous = await call("/api/upload-video", { method: "POST", headers: jsonHeaders, body: "{}" });
check("POST /api/upload-video without a session → 401", uploadAnonymous.status === 401, `status ${uploadAnonymous.status}`);

const uploadNoToken = await call("/api/upload-video", {
  method: "POST",
  headers: { ...jsonHeaders, Cookie: cookie },
  body: JSON.stringify({ finalize: true, pathname: `videos/${id}.mp4`, filename: "x.mp4", category: "c", size: 1 }),
});
check("POST /api/upload-video without a store → 503", uploadNoToken.status === 503, `status ${uploadNoToken.status}`);

const uploadWrongMethod = await call("/api/upload-video");
check("GET /api/upload-video → 405", uploadWrongMethod.status === 405, `status ${uploadWrongMethod.status}`);
check(
  "405 responses advertise the allowed methods",
  (uploadWrongMethod.headers.get("allow") || "").includes("POST")
);

const logout = await call("/api/auth-logout", { method: "POST", headers: { Cookie: cookie } });
const clearedCookie = logout.headers.get("set-cookie") || "";
check("POST /api/auth-logout → 200", logout.status === 200, `status ${logout.status}`);
check("logout clears the session cookie", /__session=;/.test(clearedCookie) && /Max-Age=0/.test(clearedCookie));

await new Promise((resolve) => server.close(resolve));

// ============================================================
//  3. Real blob store (needs credentials)
// ============================================================

if (!REAL_TOKEN) {
  console.log("\napi handlers (real blob store)");
  console.log("  skipped — no BLOB_READ_WRITE_TOKEN in .env.local or the environment");
} else {
  section("api handlers (real blob store)");
  process.env.BLOB_READ_WRITE_TOKEN = REAL_TOKEN;

  const live = await startServer({ port: 0 });
  const liveBase = `http://localhost:${live.address().port}`;
  const liveCall = (path, options = {}) => fetch(liveBase + path, options);

  const liveLogin = await liveCall("/api/auth-login", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ password: PASSCODE }),
  });
  const liveCookie = (liveLogin.headers.get("set-cookie") || "").split(";")[0];

  // Upload step 1: the server must sign a token for a pathname the admin chose.
  const uploadId = newId();
  const tokenResponse = await liveCall("/api/upload-video", {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: liveCookie },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: {
        pathname: `videos/${uploadId}.mp4`,
        clientPayload: JSON.stringify({ filename: "Test clip.mp4", category: "Testing" }),
        multipart: false,
      },
    }),
  });
  const tokenBody = await tokenResponse.json();
  check("upload token request → 200", tokenResponse.status === 200, JSON.stringify(tokenBody));
  check("upload token is a blob client token", String(tokenBody.clientToken || "").startsWith("vercel_blob_client_"));

  const badPathToken = await liveCall("/api/upload-video", {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: liveCookie },
    body: JSON.stringify({
      type: "blob.generate-client-token",
      payload: { pathname: `secrets/${uploadId}.mp4`, clientPayload: null, multipart: false },
    }),
  });
  check("upload token for a foreign pathname → 400", badPathToken.status === 400, `status ${badPathToken.status}`);

  const bogusFinalize = await liveCall("/api/upload-video", {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: liveCookie },
    body: JSON.stringify({
      finalize: true,
      pathname: `videos/${newId()}.mp4`,
      filename: "Never uploaded.mp4",
      category: "Testing",
      size: 100,
    }),
  });
  check("finalize for an upload that never happened → 409", bogusFinalize.status === 409, `status ${bogusFinalize.status}`);

  // Link videos: create, list, delete.
  const created = await liveCall("/api/videos", {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: liveCookie },
    body: JSON.stringify({ title: "Integration clip", category: "Testing", url: "https://youtu.be/dQw4w9WgXcQ" }),
  });
  const createdBody = await created.json();
  check("POST /api/videos → 200 with a key", created.status === 200 && isId(createdBody.key), JSON.stringify(createdBody));

  const publicList = await liveCall("/api/videos");
  check(
    "GET /api/videos is cacheable for visitors",
    (publicList.headers.get("Cache-Control") || "").includes("s-maxage"),
    publicList.headers.get("Cache-Control") || ""
  );

  const listed = await liveCall("/api/videos?fresh=1");
  const listedBody = await listed.json();
  const found = Array.isArray(listedBody) ? listedBody.find((v) => v.key === createdBody.key) : null;
  check("the new video appears in the list", !!found, JSON.stringify(listedBody).slice(0, 200));
  check("the listed video keeps its title and category", found?.filename === "Integration clip" && found?.category === "Testing");
  check("the listed video is marked external", found?.external === true);

  const rejected = await liveCall("/api/videos", {
    method: "POST",
    headers: { ...jsonHeaders, Cookie: liveCookie },
    body: JSON.stringify({ title: "Bad link", category: "Testing", url: "javascript:alert(1)" }),
  });
  check("POST /api/videos rejects a javascript: url → 400", rejected.status === 400, `status ${rejected.status}`);

  const removed = await liveCall(`/api/videos?key=${createdBody.key}`, {
    method: "DELETE",
    headers: { Cookie: liveCookie },
  });
  check("DELETE /api/videos → 200", removed.status === 200, `status ${removed.status}`);

  const afterDelete = await (await liveCall("/api/videos?fresh=1")).json();
  check(
    "the deleted video is gone",
    Array.isArray(afterDelete) && !afterDelete.some((v) => v.key === createdBody.key)
  );

  await new Promise((resolve) => live.close(resolve));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
