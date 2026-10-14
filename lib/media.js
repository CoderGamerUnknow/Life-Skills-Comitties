/**
 * Media rules shared by the API and (mirrored in) the admin panel:
 * which kinds exist, what may be uploaded, where it is stored and how a stored
 * record is turned into the shape the frontend renders.
 *
 * Everything in here is pure so it can be unit tested without a Blob store.
 */

/** Upload rules per kind. Prefixes keep media and metadata apart in one store. */
export const KINDS = {
  video: {
    mediaPrefix: "videos/",
    recordPrefix: "data/videos/",
    extensions: ["mp4", "webm", "mov", "m4v", "ogv"],
    contentTypes: ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/ogg"],
    maxBytes: 200 * 1024 * 1024,
  },
};

export const ID_PATTERN = /^[0-9a-f]{32}$/;

/** Ids are generated in the browser so an interrupted upload cannot collide. */
export function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function isId(value) {
  return ID_PATTERN.test(String(value ?? ""));
}

export function isExtensionAllowed(kind, extension) {
  return KINDS[kind].extensions.includes(String(extension ?? "").toLowerCase());
}

export function mediaPathname(kind, id, extension) {
  return `${KINDS[kind].mediaPrefix}${id}.${String(extension).toLowerCase()}`;
}

/**
 * Validate a pathname the browser asked to upload to.
 * Only `videos/<32 hex>.<allowed ext>` is accepted, so
 * even with a valid admin session nothing can be written outside these folders.
 * @returns {{id: string, extension: string}|null}
 */
export function parseMediaPathname(kind, pathname) {
  const config = KINDS[kind];
  const raw = String(pathname ?? "");
  if (!raw.startsWith(config.mediaPrefix)) return null;
  const match = /^([0-9a-f]{32})\.([a-z0-9]{1,8})$/.exec(raw.slice(config.mediaPrefix.length));
  if (!match || !config.extensions.includes(match[2])) return null;
  return { id: match[1], extension: match[2] };
}

/** Collapse whitespace and cap the length of a user-supplied label. */
export function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Only http(s) links are accepted, so stored links can never be javascript:. */
export function cleanHttpUrl(value, maxLength = 2000) {
  const raw = String(value ?? "").trim().slice(0, maxLength);
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Newest first; records fall back to the epoch when addedAt is missing. */
export function byNewest(a, b) {
  return String(b?.addedAt || "").localeCompare(String(a?.addedAt || ""));
}

/** Stored video record -> the shape public/js/videos.js consumes. */
export function toPublicVideo(record) {
  if (!record || !isId(record.id) || !record.url) return null;
  const external = record.kind === "link";
  return {
    key: record.id,
    filename: cleanText(external ? record.title || record.filename : record.filename, 200) || record.id,
    category: cleanText(record.category, 60) || "General",
    size: external ? 0 : Number(record.size) || 0,
    external,
    url: record.url,
    addedAt: record.addedAt || "",
  };
}
