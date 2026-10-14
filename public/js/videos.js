/**
 * Videos page — list from /api/videos, filter by category chips.
 * Supports YouTube embeds (youtube.com/watch?v= or youtu.be/) and
 * direct video files hosted in the Vercel Blob store (mp4/webm).
 */

const grid = document.getElementById("video-grid");
const empty = document.getElementById("video-empty");
const filterBar = document.getElementById("filter-bar");
let allVideos = [];
let activeCategory = "all";

document.addEventListener("DOMContentLoaded", async () => {
  if (!grid) return;

  let videos = [];
  try {
    videos = await apiFetch("/api/videos");
  } catch {
    videos = [];
  }
  allVideos = videos;

  // Dedupe categories, keep insertion order
  const categories = [];
  const seen = new Set();
  for (const v of videos) {
    if (!seen.has(v.category)) {
      seen.add(v.category);
      categories.push(v.category);
    }
  }

  // Render filter chips
  if (filterBar) {
    // Keep the "All" chip; remove any others we might have left from a
    // previous render (none on first load, but safe).
    filterBar.innerHTML = "";
    const allChip = document.createElement("button");
    allChip.className = "filter-chip active";
    allChip.dataset.category = "all";
    allChip.textContent = "All";
    allChip.addEventListener("click", () => {
      setFilter("all");
    });
    filterBar.appendChild(allChip);

    for (const cat of categories) {
      const chip = document.createElement("button");
      chip.className = "filter-chip";
      chip.dataset.category = cat;
      chip.textContent = cat;
      chip.addEventListener("click", () => {
        setFilter(cat);
      });
      filterBar.appendChild(chip);
    }
  }

  renderVideos(videos);
});

function setFilter(category) {
  activeCategory = category;
  // Toggle active class
  if (filterBar) {
    filterBar.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.category === category);
    });
  }
  renderVideos(allVideos);
}

function renderVideos(videos) {
  if (!grid) return;
  grid.innerHTML = "";

  const filtered =
    activeCategory === "all"
      ? videos
      : videos.filter((v) => v.category === activeCategory);

  if (filtered.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }

  if (empty) empty.hidden = true;

  for (const v of filtered) {
    const card = document.createElement("div");
    card.className = "video-card";

    const thumb = document.createElement("div");
    thumb.className = "video-thumb";

    // A malformed stored URL must not blank the whole grid. Fall back to a
    // plain, non-embeddable card for that one item instead of throwing here.
    let url = null;
    try {
      url = new URL(v.url);
    } catch {
      url = null;
    }
    const isYouTube = Boolean(url) && (url.hostname.includes("youtube") || url.hostname.includes("youtu"));
    const nameLower = v.filename.toLowerCase();
    const pathLower = url ? url.pathname.toLowerCase() : "";
    const isDirectVideo = [".mp4", ".webm", ".mov", ".ogg"].some(
      (ext) => pathLower.endsWith(ext) || nameLower.endsWith(ext)
    );

    if (isYouTube) {
      // Convert watch?v= or youtu.be/ to embed src
      let embedId = null;
      if (url.hostname.includes("youtu.be")) {
        embedId = url.pathname.slice(1).split("?")[0];
      } else if (url.searchParams.has("v")) {
        embedId = url.searchParams.get("v");
      }
      if (embedId) {
        const iframe = document.createElement("iframe");
        iframe.src = `https://www.youtube-nocookie.com/embed/${embedId}?rel=0`;
        iframe.title = v.filename;
        iframe.allow =
          "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture";
        iframe.allowFullscreen = true;
        thumb.appendChild(iframe);
      } else {
        thumb.innerHTML = `<div class="play-badge">▶</div>`;
        thumb.title = "Could not extract YouTube ID";
      }
    } else if (isDirectVideo) {
      const video = document.createElement("video");
      video.src = v.url;
      video.controls = true;
      video.preload = "metadata";
      video.setAttribute("aria-label", v.filename);
      thumb.appendChild(video);
    } else {
      thumb.innerHTML = `<div class="play-badge">▶</div>`;
    }

    const info = document.createElement("div");
    info.className = "video-info";
    let metaText = formatSize(v.size);
    if (v.external) {
      try {
        metaText = "Link · " + url.hostname.replace(/^www\./, "");
      } catch {
        metaText = "External link";
      }
    }
    info.innerHTML = `
      <span class="video-category-tag">${escapeHtml(v.category)}</span>
      <h3>${escapeHtml(v.filename)}</h3>
      <div class="video-meta">${escapeHtml(metaText)}</div>
    `;

    card.appendChild(thumb);
    card.appendChild(info);
    grid.appendChild(card);
  }
}

function formatSize(bytes) {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
