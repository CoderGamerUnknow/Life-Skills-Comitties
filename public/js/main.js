/**
 * Shared helpers used by all pages.
 * - signIn(): redirects to Freebuff auth.
 * - getUser(): returns current user (or null) via the auth endpoint.
 * - signOut(): clears session and reloads.
 * - apiFetch(): thin wrapper around fetch that parses JSON and throws on errors.
 * - toast(): transient notification helper (used by admin panel).
 */

/** Domain the app is deployed on (relative — works in preview & prod). */
const APP_ORIGIN = ""; // empty = same origin

function apiPath(path) {
  return (APP_ORIGIN ? APP_ORIGIN.replace(/\/+$/, "") : "") + path;
}

/** Fetch JSON from an API route, throwing on non-2xx. */
async function apiFetch(path, options = {}) {
  const isFormUpload = options.body instanceof FormData;
  const headers = new Headers(options.headers);

  // For a FormData upload the browser must generate the
  // `multipart/form-data; boundary=...` header itself. Setting JSON here
  // overrides that, and the server then refuses to parse the body.
  if (!isFormUpload && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(apiPath(path), { ...options, headers });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      msg = body.error || body.message || msg;
    } catch {
      // non-JSON error response
    }
    throw new Error(msg);
  }
  // Some endpoints return non-JSON (e.g. 204). Guard.
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

/** Read the current user, if any. Returns null when not signed in. */
async function getUser() {
  try {
    const user = await apiFetch("/api/auth/user", { method: "GET" });
    return user || null;
  } catch {
    return null;
  }
}

/** Initiate Sign in with Freebuff. */
function signIn() {
  const authUrl = apiPath("/auth/freebuff");
  window.location.href = authUrl;
}

/** Sign out and reload the page. */
function signOut() {
  fetch(apiPath("/auth/freebuff/logout"), { method: "POST" }).then(() => {
    window.location.href = window.location.pathname;
  });
}

/** Simple toast shown for a few seconds. Styling lives in css/style.css. */
function toast(message, type = "info") {
  const existing = document.querySelector(".toast-msg");
  if (existing) existing.remove();

  const el = document.createElement("div");
  el.className = "toast-msg toast-" + type;
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("show");
  });

  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

/**
 * Shows the auth gate on the admin page.
 * @param {HTMLDivElement} statusEl  element showing the status badge
 * @param {HTMLDivElement} actionsEl element with sign-out + user email
 * @returns {Promise<boolean>} whether the user is signed in
 */
async function applyAuthGate(statusEl, actionsEl) {
  statusEl.hidden = false;
  actionsEl.hidden = true;
  statusEl.innerHTML = `<span class="status-badge status-pending">Checking sign-in…</span>`;

  let user;
  try {
    user = await getUser();
  } catch {
    user = null;
  }

  if (user) {
    statusEl.innerHTML = `<span class="status-badge status-signed-in">Signed in as ${escapeHtml(user.email || user.name || "admin")}</span>`;
    const emailEl = document.getElementById("user-email");
    if (emailEl) emailEl.textContent = user.email || user.name || "admin";
    actionsEl.hidden = false;
    return true;
  } else {
    statusEl.innerHTML = `<span class="status-badge status-blocked">Not signed in — admin only.</span>`;
    actionsEl.hidden = false;
    return false;
  }
}

/** Minimal HTML escape. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
