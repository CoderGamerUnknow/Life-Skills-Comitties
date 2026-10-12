/**
 * Vercel Blob access.
 *
 * Layout inside the single blob store:
 *   videos/<id>.<ext>            uploaded video file (public)
 *   photos/<id>.<ext>            uploaded photo file (public)
 *   data/videos/<id>.json        metadata record for a video (public)
 *   data/photos/<id>.json        metadata record for a photo (public)
 *
 * Client uploads pick their own pathname, but only after the API has validated
 * it and signed a token for it, so media can only ever land in those folders.
 * Each record is written once and deleted with its file — no index to update,
 * so two uploads at the same time cannot overwrite each other's entry.
 *
 * Blob has no "custom metadata" field, which is why the record carries things
 * like the original filename and skill category. Records are immutable and read
 * through their public URL, so repeat reads are served by the CDN.
 */

import { del, head, list, put } from "@vercel/blob";
import { KINDS } from "./media.js";

/** Vercel injects BLOB_READ_WRITE_TOKEN once a Blob store is connected. */
export function blobConfigured() {
  return Boolean(String(process.env.BLOB_READ_WRITE_TOKEN || "").trim());
}

/** Every record of a kind, newest-first sorting is left to the caller. */
export async function listRecords(kind) {
  const prefix = KINDS[kind].recordPrefix;
  const records = [];
  let cursor;

  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    const loaded = await Promise.all(page.blobs.map(readRecordAt));
    for (const record of loaded) if (record) records.push(record);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return records;
}

export async function readRecord(kind, id) {
  try {
    const meta = await head(`${KINDS[kind].recordPrefix}${id}.json`);
    return await readRecordAt(meta);
  } catch {
    return null;
  }
}

async function readRecordAt(blob) {
  try {
    const response = await fetch(blob.url);
    if (!response.ok) return null;
    const record = await response.json();
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

export async function writeRecord(kind, record) {
  const pathname = `${KINDS[kind].recordPrefix}${record.id}.json`;
  await put(pathname, JSON.stringify(record), {
    access: "public",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return pathname;
}

/** Remove a record and, for uploaded files, the file itself. */
export async function removeRecord(kind, record) {
  const pathnames = [`${KINDS[kind].recordPrefix}${record.id}.json`];
  if (typeof record.pathname === "string" && record.pathname) pathnames.push(record.pathname);
  await del(pathnames);
}
