/**
 * About page — Heads & Mistress.
 * Pulls uploaded images from /api/images and renders profile cards.
 * Hardcoded leadership names (Joanna, Mrs Natasha Steve); images are
 * matched to person by upload type (head / mistress) and recency.
 */

const TEAM = [
  {
    id: "head-joanna",
    name: "Joanna",
    role: "Head",
    bio: "Leads the committee and helps shape the direction of each session. Always looking for new ways to make life skills practical and engaging.",
    imageType: "head",
  },
  {
    id: "mistress-natasha",
    name: "Mrs Natasha Steve",
    role: "Mistress",
    bio: "Oversees the committee and mentors members through their growth. Brings warmth and structure to every meeting.",
    imageType: "mistress",
  },
];

document.addEventListener("DOMContentLoaded", async () => {
  const grid = document.getElementById("team-grid");
  const empty = document.getElementById("team-empty");
  if (!grid) return;

  let images = [];
  try {
    images = await apiFetch("/api/images");
  } catch {
    images = [];
  }

  // Group images by type, newest first
  const byType = { head: [], mistress: [] };
  for (const img of images) {
    const t = img.type === "mistress" ? "mistress" : "head";
    byType[t].push(img);
  }

  let rendered = 0;
  for (const person of TEAM) {
    const photo = (byType[person.imageType] || [])[0];
    const card = document.createElement("a");
    card.href = "#";
    card.className = "team-card";
    card.setAttribute("aria-label", `View ${person.name}`);

    const hasImage = photo && photo.url;

    // Image area
    const imgWrap = document.createElement("div");
    imgWrap.className = "team-card-image" + (hasImage ? "" : " image-placeholder");

    if (hasImage) {
      const img = document.createElement("img");
      img.src = photo.url;
      img.alt = `${person.name} — ${person.role}`;
      img.loading = "lazy";
      img.onerror = () => {
        imgWrap.classList.add("image-placeholder");
        imgWrap.textContent = "👤";
        img.remove();
      };
      imgWrap.appendChild(img);
    } else {
      imgWrap.textContent = "👤";
    }

    // Body
    const body = document.createElement("div");
    body.className = "team-card-body";
    body.innerHTML = `
      <span class="role-tag">${escapeHtml(person.role)}</span>
      <h3>${escapeHtml(person.name)}</h3>
      <p>${escapeHtml(person.bio)}</p>
    `;

    card.appendChild(imgWrap);
    card.appendChild(body);
    grid.appendChild(card);
    rendered++;
  }

  if (rendered === 0) {
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
});
