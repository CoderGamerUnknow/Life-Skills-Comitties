/**
 * POST /api/auth-login — exchange the shared admin passcode for a session cookie.
 * The cookie is HttpOnly, so the browser never sees (or needs) the passcode again.
 */

import { adminConfigured, issueSession, passcodeMatches, sessionCookie } from "../lib/auth.js";
import { clientIp, fail, isSecureRequest, json, readJson } from "../lib/http.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Best-effort throttle. Lambda instances are recycled and not shared, so this
// only slows an attacker down; it is not the only line of defence.
const attempts = new Map();

function throttled(ip) {
  const entry = attempts.get(ip);
  return Boolean(entry) && Date.now() - entry.first < WINDOW_MS && entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first >= WINDOW_MS) {
    attempts.set(ip, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

export default {
  async fetch(request) {
    if (request.method.toUpperCase() !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }

    if (!adminConfigured()) {
      return fail(
        503,
        "Admin sign-in is not set up yet. Add an ADMIN_PASSWORD environment variable in your Vercel project, then redeploy."
      );
    }

    const ip = clientIp(request);
    if (throttled(ip)) {
      return fail(429, "Too many failed attempts. Please wait 15 minutes and try again.");
    }

    const body = await readJson(request);
    if (!body) return fail(400, "Invalid request body.");

    if (!(await passcodeMatches(body.password))) {
      recordFailure(ip);
      return fail(401, "That passcode is not correct.");
    }

    attempts.delete(ip);
    const token = await issueSession();
    return json({ success: true }, 200, {
      "Set-Cookie": sessionCookie(token, isSecureRequest(request)),
    });
  },
};
