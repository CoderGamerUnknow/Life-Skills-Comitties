/**
 * /api/images
 *   GET    — every uploaded photo, newest first. Public: the Heads & Mistress
 *            page reads it (photos are matched to a person by type).
 *   DELETE — remove one by `?key=<id>`. Admin only.
 *
 * Uploads go straight to the blob store; see lib/upload-handler.js.
 */

import { requireAdmin } from "../lib/auth.js";
import { fail, json } from "../lib/http.js";
import { byNewest, isId, toPublicPhoto } from "../lib/media.js";
import { blobConfigured, listRecords, readRecord, removeRecord } from "../lib/store.js";

const KIND = "photo";

export default {
  async fetch(request) {
    const method = request.method.toUpperCase();
    if (method === "GET") return listImages(request);
    if (method === "DELETE") return deleteImage(request);
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, DELETE" });
  },
};

async function listImages(request) {
  if (!blobConfigured()) return json([], 200);

  const records = await listRecords(KIND);
  const items = records.map(toPublicPhoto).filter(Boolean).sort(byNewest);

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  return json(
    items,
    200,
    fresh
      ? { "Cache-Control": "no-store" }
      : { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=300" }
  );
}

async function deleteImage(request) {
  const denied = await requireAdmin(request);
  if (denied) return denied;
  if (!blobConfigured()) {
    return fail(
      503,
      "The Vercel Blob store is not connected yet. Create a Blob store in your Vercel project, then redeploy."
    );
  }

  const key = new URL(request.url).searchParams.get("key");
  if (!isId(key)) return fail(400, "Missing or invalid photo id.");

  const record = await readRecord(KIND, key);
  if (!record) return json({ success: true, alreadyGone: true });

  await removeRecord(KIND, record);
  return json({ success: true });
}
