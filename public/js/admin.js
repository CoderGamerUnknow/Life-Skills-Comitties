/**
 * Admin panel — passcode sign-in, uploads, media lists.
 *
 * Files are sent straight from the browser to Vercel Blob using the official
 * client helper (vendored in js/vendor/), because a Vercel Function cannot
 * receive more than 4.5 MB in one request — a video could never be proxied
 * through the API. The API hands the browser a short-lived, admin-only token for
 * one exact pathname; afterwards the panel tells the API to record the upload so
 * it shows up in the Video Library.
 *
 * Runs as an ES module so it can import that helper; everything it calls
 * (apiFetch, toast, escapeHtml, applyAuthGate, signInWithPassword, signOut) is
 * a global from js/main.js, which is loaded first.
 */

import { upload } from "./vendor/vercel-blob-client.mjs";

const VIDEO = {
  folder: "videos",
  extensions: ["mp4", "webm", "mov", "m4v", "ogv"],
  maxBytes: 200 * 1024 * 1024,
  limitHint: "For longer videos, use “Add a Video by Link” instead.",
};

// Above this size the helper splits the file into parts and retries failures.
const MULTIPART_OVER_BYTES = 20 * 1024 * 1024;

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("auth-status");
  const actionsEl = document.getElementById("auth-actions");
  const loginForm = document.getElementById("login-form");
  const loginFeedback = document.getElementById("login-feedback");
  const signOutBtn = document.getElementById("sign-out-btn");
  const adminContent = document.getElementById("admin-content");
  const videoForm = document.getElementById("video-form");
  const linkForm = document.getElementById("link-form");
  const videosList = document.getElementById("videos-list");

  if (!statusEl || !actionsEl) return;

  // Apply auth gate
  const signedIn = await applyAuthGate(statusEl, actionsEl);
  const emailEl = document.getElementById("user-email");

  if (loginForm) loginForm.hidden = signedIn;
  if (emailEl) emailEl.hidden = !signedIn;
  if (signOutBtn) {
    signOutBtn.hidden = !signedIn;
    signOutBtn.addEventListener("click", () => signOut());
  }

  // Upload panels only make sense once signed in.
  if (adminContent) adminContent.hidden = !signedIn;

  // Load media lists (only if signed in)
  if (signedIn) {
    loadVideosList(videosList);
  }

  // Passcode sign-in
  if (loginForm) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const passwordInput = document.getElementById("admin-password");
      const submit = document.getElementById("sign-in-btn");
      if (!passwordInput || !submit) return;

      submit.disabled = true;
      submit.textContent = "Signing in…";
      if (loginFeedback) loginFeedback.hidden = true;

      try {
        await signInWithPassword(passwordInput.value);
        // Reload so every panel loads with the new session in place.
        window.location.reload();
      } catch (error) {
        showFeedback(loginFeedback, error.message || "Sign in failed.", "error");
        submit.disabled = false;
        submit.textContent = "Sign in";
        passwordInput.value = "";
      }
    });
  }

  // Video upload
  if (videoForm) {
    videoForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fileInput = document.getElementById("video-file");
      const categoryInput = document.getElementById("video-category");
      const feedback = document.getElementById("video-feedback");
      const submit = document.getElementById("video-submit");
      if (!fileInput || !categoryInput || !feedback || !submit) return;

      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showFeedback(feedback, "Please select a video file.", "error");
        return;
      }
      const category = categoryInput.value.trim() || "General";

      const uploaded = await runSubmit({
        button: submit,
        feedback,
        idleLabel: "Upload Video",
        work: async (setBusy) => {
          await uploadFile({
            config: VIDEO,
            file,
            endpoint: "/api/upload-video",
            payload: { filename: file.name, category },
            setBusy,
          });
        },
      });

      if (uploaded) {
        showFeedback(feedback, `Uploaded “${file.name}” to ${category}.`, "success");
        videoForm.reset();
        loadVideosList(videosList);
        toast(`Video uploaded — ${category}`, "success");
      }
    });
  }

  // Add video by link (YouTube / direct URL)
  if (linkForm) {
    linkForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const titleInput = document.getElementById("link-title");
      const categoryInput = document.getElementById("link-category");
      const urlInput = document.getElementById("link-url");
      const feedback = document.getElementById("link-feedback");
      const submit = document.getElementById("link-submit");
      if (!titleInput || !categoryInput || !urlInput || !feedback || !submit) return;

      const title = titleInput.value.trim();
      const category = categoryInput.value.trim() || "General";
      const url = urlInput.value.trim();

      const added = await runSubmit({
        button: submit,
        feedback,
        idleLabel: "Add Video Link",
        work: async () => {
          if (!title) throw new Error("Please give the video a title.");
          if (!url) throw new Error("Please paste the video URL.");
          await apiFetch("/api/videos", {
            method: "POST",
            body: JSON.stringify({ title, category, url }),
          });
        },
      });

      if (added) {
        showFeedback(feedback, `Added “${title}” to ${category}.`, "success");
        linkForm.reset();
        loadVideosList(videosList);
        toast(`Video link added — ${category}`, "success");
      }
    });
  }
});

/**
 * Run a form submission with the button in its busy state.
 * @returns {Promise<boolean>} whether the work finished without throwing
 */
async function runSubmit({ button, feedback, idleLabel, work }) {
  button.disabled = true;
  button.textContent = `${idleLabel}…`;
  if (feedback) feedback.hidden = true;

  try {
    await work((message) => {
      button.textContent = message;
    });
    return true;
  } catch (error) {
    showFeedback(feedback, error?.message || "Upload failed.", "error");
    return false;
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
}

/** Upload one file to the blob store, then record it through the API. */
async function uploadFile({ config, file, endpoint, payload, setBusy }) {
  const extension = (file.name.split(".").pop() || "").toLowerCase();
  if (!config.extensions.includes(extension)) {
    throw new Error(
      `Unsupported file type “.${extension}”. Allowed: ${config.extensions.join(", ")}.`
    );
  }
  if (file.size > config.maxBytes) {
    throw new Error(
      `${formatSize(file.size)} is over the ${formatSize(config.maxBytes)} limit. ${config.limitHint}`
    );
  }

  // Ids are made here so an interrupted upload can never collide with another.
  const id = randomId();
  const pathname = `${config.folder}/${id}.${extension}`;

  let blob;
  try {
    blob = await upload(pathname, file, {
      access: "public",
      handleUploadUrl: endpoint,
      contentType: file.type || undefined,
      multipart: file.size > MULTIPART_OVER_BYTES,
      clientPayload: JSON.stringify(payload),
      onUploadProgress: ({ percentage }) => setBusy(`Uploading… ${percentage}%`),
    });
  } catch (error) {
    // The blob client reports a generic "Failed to retrieve the client token"
    // when the token step fails, hiding the server's reason (store not
    // connected, session expired, …). Ask the endpoint directly so the admin
    // sees something actionable.
    const reason = await explainUploadFailure(endpoint, pathname, payload);
    throw new Error(reason || error?.message || "Upload failed.");
  }

  try {
    await apiFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({
        finalize: true,
        pathname: blob.pathname || pathname,
        size: file.size,
        ...payload,
      }),
    });
  } catch (error) {
    throw new Error(
      `The file uploaded but the site could not record it (${error.message}). Please try again.`
    );
  }
}

/**
 * Ask the upload endpoint why it refused a token, so the panel can show the
 * server's own explanation instead of the client helper's generic message.
 * @returns {Promise<string>} a human-readable reason, or "" if unavailable
 */
async function explainUploadFailure(endpoint, pathname, payload) {
  try {
    const res = await fetch(apiPath(endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "blob.generate-client-token",
        payload: { pathname, clientPayload: JSON.stringify(payload), multipart: false },
      }),
    });
    if (res.ok) return "";
    const body = await res.json().catch(() => null);
    return body?.error || `The server refused the upload (status ${res.status}).`;
  } catch {
    return "";
  }
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Render the videos list with delete buttons. */
async function loadVideosList(listEl) {
  if (!listEl) return;
  let videos = [];
  try {
    videos = await apiFetch("/api/videos?fresh=1");
  } catch {
    videos = [];
  }

  listEl.innerHTML = "";
  if (videos.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No videos uploaded yet.</div>`;
    return;
  }

  for (const video of videos) {
    const item = document.createElement("div");
    item.className = "media-item";

    const thumb = document.createElement("div");
    thumb.className = "media-item-thumb video";
    thumb.textContent = video.external ? "🔗" : "▶";

    const info = document.createElement("div");
    info.className = "media-item-info";
    const metaParts = [video.external ? "Link" : "File", video.category || "General"];
    if (!video.external && formatSize(video.size)) metaParts.push(formatSize(video.size));
    metaParts.push(addedLabel(video.addedAt));
    info.innerHTML = `
      <div class="media-name">${escapeHtml(video.filename)}</div>
      <div class="media-meta">${escapeHtml(metaParts.join(" · "))}</div>
    `;

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${video.filename}"?`)) return;
      try {
        await apiFetch(`/api/videos?key=${encodeURIComponent(video.key)}`, { method: "DELETE" });
        loadVideosList(listEl);
        toast("Video deleted.", "info");
      } catch (err) {
        toast("Delete failed: " + err.message, "error");
      }
    });

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(del);
    listEl.appendChild(item);
  }
}

function showFeedback(el, message, type) {
  if (!el) return;
  el.hidden = false;
  el.textContent = message;
  el.className = "form-feedback " + type;
}

function addedLabel(value) {
  if (!value) return "Added recently";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Added recently";
  return "Added " + date.toLocaleDateString();
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
