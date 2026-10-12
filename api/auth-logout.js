/**
 * POST /api/auth-logout — clear the admin session cookie.
 */

import { clearedSessionCookie } from "../lib/auth.js";
import { isSecureRequest, json } from "../lib/http.js";

export default {
  async fetch(request) {
    if (request.method.toUpperCase() !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
    }
    return json({ success: true }, 200, {
      "Set-Cookie": clearedSessionCookie(isSecureRequest(request)),
    });
  },
};
