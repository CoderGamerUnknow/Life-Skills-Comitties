/**
 * GET /api/auth-user — who is driving the admin panel, if anyone.
 *
 * The passcode cannot tell admins apart, so the panel just shows a generic name
 * and the presence of a valid session is what unlocks the upload forms.
 */

import { adminConfigured, isSignedIn } from "../lib/auth.js";
import { fail, json } from "../lib/http.js";

export default {
  async fetch(request) {
    if (request.method.toUpperCase() !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }

    if (!adminConfigured()) {
      return fail(
        503,
        "Admin sign-in is not set up yet. Add an ADMIN_PASSWORD environment variable in your Vercel project, then redeploy."
      );
    }

    if (!(await isSignedIn(request))) {
      return fail(401, "Not signed in.");
    }

    return json(
      { sub: "admin", name: "Committee Admin" },
      200,
      { "Cache-Control": "private, no-store" }
    );
  },
};
