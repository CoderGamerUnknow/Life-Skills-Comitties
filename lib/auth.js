/**
 * Admin sign-in for the Vercel deploy: one shared passcode (ADMIN_PASSWORD)
 * exchanged for a signed, HttpOnly session cookie.
 *
 * The cookie is `<issuedAt>.<hmac>`, the HMAC computed over the timestamp with
 * the passcode as its key. That lets the server validate a session without
 * storing one, and keeps the passcode itself out of the browser: the only thing
 * the client ever holds is this derived token, which expires after 30 days.
 */

import { fail, getCookie, isSameOrigin } from "./http.js";

export const COOKIE_NAME = "__session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

export function adminPasscode() {
  return String(process.env.ADMIN_PASSWORD || "").trim();
}

/** True once the passcode has been configured in the Vercel project. */
export function adminConfigured() {
  return adminPasscode().length > 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Compare a submitted passcode with the configured one. Both sides are hashed
 * first so the comparison is constant-time and does not leak the length.
 */
export async function passcodeMatches(candidate) {
  if (!adminConfigured()) return false;
  const [expected, submitted] = await Promise.all([
    hmacHex("life-skills-committee", adminPasscode()),
    hmacHex("life-skills-committee", String(candidate ?? "")),
  ]);
  return timingSafeEqual(expected, submitted);
}

export async function issueSession() {
  const issuedAt = Date.now();
  const signature = await hmacHex(adminPasscode(), `v1:${issuedAt}`);
  return `${issuedAt}.${signature}`;
}

function cookieAttributes(secure) {
  return `Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=Lax`;
}

export function sessionCookie(token, secure) {
  return `${COOKIE_NAME}=${token}; ${cookieAttributes(secure)}; Max-Age=${
    SESSION_TTL_MS / 1000
  }`;
}

export function clearedSessionCookie(secure) {
  return `${COOKIE_NAME}=; ${cookieAttributes(secure)}; Max-Age=0`;
}

export async function isSignedIn(request) {
  if (!adminConfigured()) return false;
  const raw = getCookie(request, COOKIE_NAME);
  if (!raw) return false;

  const [issuedAt, signature] = raw.split(".");
  if (!/^\d{10,}$/.test(issuedAt || "") || !signature) return false;
  if (Date.now() - Number(issuedAt) > SESSION_TTL_MS) return false;

  const expected = await hmacHex(adminPasscode(), `v1:${issuedAt}`);
  return timingSafeEqual(expected, signature);
}

/**
 * Guard for admin-only endpoints.
 * @returns {Response|null} a response to send back, or null when allowed.
 */
export async function requireAdmin(request) {
  if (!adminConfigured()) {
    return fail(
      503,
      "Admin sign-in is not set up yet. Add an ADMIN_PASSWORD environment variable in your Vercel project, then redeploy."
    );
  }
  if (!isSameOrigin(request)) return fail(403, "Forbidden");
  if (!(await isSignedIn(request))) {
    return fail(401, "Unauthorized — sign in from the admin panel.");
  }
  return null;
}
