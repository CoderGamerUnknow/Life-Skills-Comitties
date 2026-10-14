/**
 * POST /api/auth-login — exchange the shared admin passcode for a session cookie.
 * The cookie is HttpOnly, so the browser never sees (or needs) the passcode again.
 *
 * Failed attempts are throttled per client address. When Upstash Redis is
 * configured the counter is shared across every serverless instance (see
 * lib/ratelimit.js); otherwise a per-instance in-memory fallback is used.
 */

import { adminConfigured, issueSession, passcodeMatches, sessionCookie } from "../lib/auth.js";
import { clientIp, fail, isSecureRequest, json, readJson } from "../lib/http.js";
import { clearFailures, isThrottled, recordFailure } from "../lib/ratelimit.js";

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
    const throttle = await isThrottled(ip);
    if (throttle.blocked) {
      return fail(429, "Too many failed attempts. Please wait a few minutes and try again.", {
        "Retry-After": String(throttle.retryAfterSeconds),
      });
    }

    const body = await readJson(request);
    if (!body) return fail(400, "Invalid request body.");

    if (!(await passcodeMatches(body.password))) {
      await recordFailure(ip);
      return fail(401, "That passcode is not correct.");
    }

    await clearFailures(ip);
    const token = await issueSession();
    return json({ success: true }, 200, {
      "Set-Cookie": sessionCookie(token, isSecureRequest(request)),
    });
  },
};
