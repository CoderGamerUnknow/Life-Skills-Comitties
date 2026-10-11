/**
 * Admin panel — auth gate, video upload, image upload, media lists.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("auth-status");
  const actionsEl = document.getElementById("auth-actions");
  const signInBtn = document.getElementById("sign-in-btn");
  const signOutBtn = document.getElementById("sign-out-btn");
  const adminContent = document.getElementById("admin-content");
  const videoForm = document.getElementById("video-form");
  const imageForm = document.getElementById("image-form");
  const linkForm = document.getElementById("link-form");
  const imagesList = document.getElementById("images-list");
  const videosList = document.getElementById("videos-list");

  if (!statusEl || !actionsEl) return;

  // Apply auth gate
  const signedIn = await applyAuthGate(statusEl, actionsEl);

  if (signInBtn) {
    signInBtn.hidden = signedIn;
    signInBtn.addEventListener("click", () => signIn());
  }
  if (signOutBtn) {
    signOutBtn.hidden = !signedIn;
    signOutBtn.addEventListener("click", () => {
      signOut();
    });
  }
  const emailEl = document.getElementById("user-email");
  if (emailEl) emailEl.hidden = !signedIn;

  // Upload panels only make sense once signed in.
  if (adminContent) adminContent.hidden = !signedIn;

  // Load media lists (only if signed in)
  if (signedIn) {
    loadImagesList(imagesList);
    loadVideosList(videosList);
  }

  // Video upload
  if (videoForm) {
    videoForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById("video-file");
      const categoryInput = document.getElementById("video-category");
      const feedback = document.getElementById("video-feedback");
      const submit = document.getElementById("video-submit");

      if (!fileInput || !categoryInput || !feedback || !submit) return;

      if (!fileInput.files || !fileInput.files[0]) {
        showFeedback(feedback, "Please select a video file.", "error");
        return;
      }

      submit.disabled = true;
      submit.textContent = "Uploading…";
      feedback.hidden = true;

      const formData = new FormData();
      formData.append("video", fileInput.files[0]);
      formData.append("category", categoryInput.value.trim());

      try {
        const result = await apiFetch("/api/upload/video", {
          method: "POST",
          body: formData,
        });
        showFeedback(feedback, `Uploaded: ${result.filename} (${result.category})`, "success");
        videoForm.reset();
        loadVideosList(videosList);
        toast(`Video uploaded — ${result.category}`, "success");
      } catch (err) {
        showFeedback(feedback, err.message || "Upload failed.", "error");
      } finally {
        submit.disabled = false;
        submit.textContent = "Upload Video";
      }
    });
  }

  // Image upload
  if (imageForm) {
    imageForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById("image-file");
      const typeSelect = document.getElementById("image-type");
      const feedback = document.getElementById("image-feedback");
      const submit = document.getElementById("image-submit");

      if (!fileInput || !typeSelect || !feedback || !submit) return;

      if (!fileInput.files || !fileInput.files[0]) {
        showFeedback(feedback, "Please select an image file.", "error");
        return;
      }

      submit.disabled = true;
      submit.textContent = "Uploading…";
      feedback.hidden = true;

      const formData = new FormData();
      formData.append("image", fileInput.files[0]);
      formData.append("type", typeSelect.value);

      try {
        const result = await apiFetch("/api/upload/image", {
          method: "POST",
          body: formData,
        });
        showFeedback(feedback, `Uploaded: ${result.filename} (${result.type})`, "success");
        imageForm.reset();
        loadImagesList(imagesList);
        toast(`Photo uploaded — ${result.type}`, "success");
      } catch (err) {
        showFeedback(feedback, err.message || "Upload failed.", "error");
      } finally {
        submit.disabled = false;
        submit.textContent = "Upload Photo";
      }
    });
  }

  // Add video by link (YouTube / direct URL)
  if (linkForm) {
    linkForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const titleInput = document.getElementById("link-title");
      const categoryInput = document.getElementById("link-category");
      const urlInput = document.getElementById("link-url");
      const feedback = document.getElementById("link-feedback");
      const submit = document.getElementById("link-submit");

      if (!titleInput || !categoryInput || !urlInput || !feedback || !submit) return;

      submit.disabled = true;
      submit.textContent = "Adding…";
      feedback.hidden = true;

      try {
        const result = await apiFetch("/api/videos/link", {
          method: "POST",
          body: JSON.stringify({
            title: titleInput.value.trim(),
            category: categoryInput.value.trim(),
            url: urlInput.value.trim(),
          }),
        });
        showFeedback(feedback, `Added: ${result.title} (${result.category})`, "success");
        linkForm.reset();
        loadVideosList(videosList);
        toast(`Video link added — ${result.category}`, "success");
      } catch (err) {
        showFeedback(feedback, err.message || "Could not add link.", "error");
      } finally {
        submit.disabled = false;
        submit.textContent = "Add Video Link";
      }
    });
  }
});

/** Render the images list with delete buttons. */
async function loadImagesList(listEl) {
  if (!listEl) return;
  let images = [];
  try {
    images = await apiFetch("/api/images");
  } catch {
    images = [];
  }

  listEl.innerHTML = "";
  if (images.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No photos uploaded yet.</div>`;
    return;
  }

  // Sort newest first
  images.sort((a, b) => b.key.localeCompare(a.key));

  for (const img of images) {
    const item = document.createElement("div");
    item.className = "media-item";

    const thumb = document.createElement("div");
    thumb.className = "media-item-thumb";
    const thumbImg = document.createElement("img");
    thumbImg.src = img.url;
    thumbImg.alt = img.filename;
    thumbImg.loading = "lazy";
    thumbImg.onerror = () => {
      thumb.classList.add("video");
      thumb.innerHTML = "🖼";
      thumbImg.remove();
    };
    thumb.appendChild(thumbImg);

    const info = document.createElement("div");
    info.className = "media-item-info";
    info.innerHTML = `
      <div class="media-name">${escapeHtml(img.filename)}</div>
      <div class="media-meta">${escapeHtml(img.type === "mistress" ? "Mistress" : "Head")} · ${img.url.split("/").pop()}</div>
    `;

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${img.filename}"?`)) return;
      try {
        await apiFetch(`/api/images/${encodeURIComponent(img.key)}`, {
          method: "DELETE",
        });
        loadImagesList(listEl);
        toast("Photo deleted.", "info");
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

/** Render the videos list with delete buttons. */
async function loadVideosList(listEl) {
  if (!listEl) return;
  let videos = [];
  try {
    videos = await apiFetch("/api/videos");
  } catch {
    videos = [];
  }

  listEl.innerHTML = "";
  if (videos.length === 0) {
    listEl.innerHTML = `<div class="empty-state">No videos uploaded yet.</div>`;
    return;
  }

  videos.sort((a, b) => b.key.localeCompare(a.key));

  for (const v of videos) {
    const item = document.createElement("div");
    item.className = "media-item";

    const thumb = document.createElement("div");
    thumb.className = "media-item-thumb video";
    thumb.textContent = v.external ? "🔗" : "▶";

    const info = document.createElement("div");
    info.className = "media-item-info";
    const metaParts = [v.external ? "Link" : "File", v.category];
    if (!v.external && formatSize(v.size)) metaParts.push(formatSize(v.size));
    info.innerHTML = `
      <div class="media-name">${escapeHtml(v.filename)}</div>
      <div class="media-meta">${escapeHtml(metaParts.join(" · "))}</div>
    `;

    const del = document.createElement("button");
    del.className = "btn-danger";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${v.filename}"?`)) return;
      try {
        await apiFetch(`/api/videos/${encodeURIComponent(v.key)}`, {
          method: "DELETE",
        });
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

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
