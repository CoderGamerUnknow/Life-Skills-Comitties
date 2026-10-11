/**
 * Members page — list by name only.
 * Placeholder names shown until the final roster is confirmed.
 */

const PLACEHOLDER_MEMBERS = [
  "[Member Name 1]",
  "[Member Name 2]",
  "[Member Name 3]",
  "[Member Name 4]",
  "[Member Name 5]",
];

document.addEventListener("DOMContentLoaded", () => {
  const list = document.getElementById("members-list");
  if (!list) return;

  for (const name of PLACEHOLDER_MEMBERS) {
    const chip = document.createElement("div");
    chip.className = "member-chip placeholder";
    chip.textContent = name;
    list.appendChild(chip);
  }
});
