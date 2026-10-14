/**
 * Local stand-in for the Vercel project.
 *
 * Serves public/ exactly the way the deployed site does (including the
 * clean-path rewrites from vercel.json and the catch-all fallback), and mounts
 * every file in api/ under its real path so the handlers can be exercised with
 * genuine Request/Response objects.
 *
 * With a blob token in .env.local this is a true end-to-end environment: the
 * browser uploads to the real store through the real API.
 *
 * Usage: npm run dev            (then open http://localhost:3000/admin)
 *        node tools/local-api-server.mjs 4000
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");

/** Mirrors the rewrites in vercel.json. */
const REWRITES = {
  "/members": "/members.html",
  "/videos": "/videos.html",
  "/admin": "/admin.html",
};

const API_ROUTES = [
  "auth-login",
  "auth-logout",
  "auth-user",
  "videos",
  "upload-video",
];

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Minimal .env.local loader (KEY=value per line, # comments, quoted values). */
export async function loadEnvFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

async function loadHandlers() {
  const handlers = new Map();
  for (const name of API_ROUTES) {
    const module = await import(pathToFileURL(join(ROOT, "api", `${name}.js`)).href);
    handlers.set(`/api/${name}`, module.default);
  }
  return handlers;
}

async function serveStatic(pathname, response) {
  const target = REWRITES[pathname] || pathname;
  const relative = normalize(target === "/" ? "/index.html" : target).replace(/^[\\/]+/, "");
  const filePath = join(PUBLIC_DIR, relative);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    response.end(body);
  } catch {
    // The deployed site falls back to the home page for unknown paths.
    try {
      const body = await readFile(join(PUBLIC_DIR, "index.html"));
      response.writeHead(200, { "Content-Type": CONTENT_TYPES[".html"] });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }
}

export async function startServer({ port = Number(process.env.PORT) || 3000 } = {}) {
  await loadEnvFile(join(ROOT, ".env.local"));
  const handlers = await loadHandlers();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, `http://localhost:${port}`);

    if (!handlers.has(url.pathname)) {
      await serveStatic(url.pathname, response);
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);

    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else headers.set(key, value);
    }
    if (!headers.has("Host")) headers.set("Host", `localhost:${port}`);

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const apiRequest = new Request(url.href, {
      method: request.method,
      headers,
      body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined,
    });

    try {
      const apiResponse = await handlers.get(url.pathname).fetch(apiRequest);
      const responseHeaders = {};
      for (const [key, value] of apiResponse.headers) responseHeaders[key] = value;
      const cookies = apiResponse.headers.getSetCookie?.() || [];
      if (cookies.length) responseHeaders["set-cookie"] = cookies;
      response.writeHead(apiResponse.status, responseHeaders);
      response.end(Buffer.from(await apiResponse.arrayBuffer()));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error?.message || "Handler crashed" }));
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || process.env.PORT || 3000);
  await startServer({ port });
  console.log(`Local API server on http://localhost:${port}`);
  console.log(
    process.env.BLOB_READ_WRITE_TOKEN
      ? "Blob token found — uploads will hit the real store."
      : "No BLOB_READ_WRITE_TOKEN (environment or .env.local) — uploads are disabled."
  );
  console.log(
    process.env.ADMIN_PASSWORD
      ? "Admin passcode found — the admin panel can sign in."
      : "No ADMIN_PASSWORD — admin endpoints will return 503."
  );
}
