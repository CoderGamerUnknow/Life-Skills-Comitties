/**
 * Small helpers shared by every function in api/.
 *
 * Vercel Functions in this project use the Web Standard signature
 * (`export default { fetch(request) {...} }`), so everything here works with
 * standard Request/Response objects — the same shape tools/local-api-server.mjs
 * feeds the handlers locally.
 */

/** JSON response. API responses are never cached unless the caller opts in. */
export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** Error response in the `{ error }` shape the frontend expects. */
export function fail(status, message, headers = {}) {
  return json({ error: message }, status, headers);
}

/** Parse a JSON request body, returning null instead of throwing. */
export async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

export function getCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

/**
 * Reject cross-site mutations (CSRF hardening). Same-origin fetches may omit
 * the Origin header, so a missing Origin is allowed; a mismatched one is not.
 */
export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const host = request.headers.get("Host") || request.headers.get("X-Forwarded-Host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function clientIp(request) {
  const forwarded = request.headers.get("X-Forwarded-For") || "";
  return forwarded.split(",")[0].trim() || request.headers.get("X-Real-Ip") || "unknown";
}

/** Vercel terminates TLS, so the browser-facing scheme comes from a header. */
export function isSecureRequest(request) {
  const proto = request.headers.get("X-Forwarded-Proto") || "";
  return proto.split(",")[0].trim() === "https";
}
