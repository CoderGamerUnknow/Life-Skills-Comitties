/**
 * /api/videos
 *   GET    — every video (uploaded files and links). Public: the Video Library
 *            page and the admin panel both read it.
 *   POST   — add a video by link (YouTube / direct URL). Admin only.
 *   DELETE — remove one by `?key=<id>`. Admin only.
 *
 * Files are uploaded straight to the blob store (see lib/upload-handler.js);
 * this endpoint only lists and edits the records around them.
 */

import { requireAdmin } from "../lib/auth.js";
import { fail, json, readJson } from "../lib/http.js";
import { byNewest, cleanHttpUrl, cleanText, isId, newId, toPublicVideo } from "../lib/media.js";
import { blobConfigured, listRecords, readRecord, removeRecord, writeRecord } from "../lib/store.js";

const KIND = "video";

export default {
  async fetch(request) {
    const method = request.method.toUpperCase();
    if (method === "GET") return listVideos(request);
    if (method === "POST") return addVideoLink(request);
    if (method === "DELETE") return deleteVideo(request);
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST, DELETE" });
  },
};

async function listVideos(request) {
  // Nothing has been set up yet — the pages should render their empty state
  // rather than an error.
  if (!blobConfigured()) return json([], 200);

  const records = await listRecords(KIND);
  const items = records.map(toPublicVideo).filter(Boolean).sort(byNewest);

  // Visitors get a short-lived cached list (one blob call per minute instead of
  // one per page view); the admin panel asks with ?fresh=1 and bypasses it so a
  // just-uploaded video is visible immediately.
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return json(
    items,
    200,
    fresh
      ? { "Cache-Control": "no-store" }
      : { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" }
  );
}

async function addVideoLink(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  if (!blobConfigured()) return storeMissing();

  const body = await readJson(request);
  if (!body) return fail(400, "Invalid JSON body.");

  const title = cleanText(body.title, 200);
  const category = cleanText(body.category, 60) || "General";
  const url = cleanHttpUrl(body.url);

  if (!title) return fail(400, "Please provide a title for the video.");
  if (!url) return fail(400, "Please provide a valid http(s) video URL.");

  const id = newId();
  const record = {
    id,
    kind: "link",
    title,
    filename: title,
    category,
    url,
    size: 0,
    addedAt: new Date().toISOString(),
  };

  await writeRecord(KIND, record);
  return json({ success: true, key: id, ...record });
}

async function deleteVideo(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  if (!blobConfigured()) return storeMissing();

  const key = new URL(request.url).searchParams.get("key");
  if (!isId(key)) return fail(400, "Missing or invalid video id.");

  const record = await readRecord(KIND, key);
  if (!record) return json({ success: true, alreadyGone: true });

  await removeRecord(KIND, record);
  return json({ success: true });
}

function storeMissing() {
  return fail(
    503,
    "The Vercel Blob store is not connected yet. Create a Blob store in your Vercel project, then redeploy."
  );
}
