/**
 * Upload endpoint shared by api/upload-video.js and api/upload-image.js.
 *
 * A file can never pass through a Vercel Function (request bodies are capped at
 * 4.5 MB), so uploading is a two-step conversation with the browser:
 *
 *   1. the browser asks for a short-lived client token with the pathname it
 *      wants to write to — only an admin gets one, and only for a pathname that
 *      matches `videos/<32 hex>.<ext>` (photos/… for images) with an allowed
 *      extension and content type;
 *   2. the browser uploads the file straight to the blob store, then calls this
 *      endpoint again to record the finished upload, which is what makes it
 *      appear in the library.
 *
 * Both steps are admin-only, so a forged record for an upload that never
 * happened is rejected at step 2 (the blob is looked up in the store).
 */

import { head } from "@vercel/blob";
import { handleUpload } from "@vercel/blob/client";
import { requireAdmin } from "./auth.js";
import { fail, json, readJson } from "./http.js";
import { KINDS, cleanText, parseMediaPathname } from "./media.js";
import { blobConfigured, writeRecord } from "./store.js";

const TOKEN_EVENT = "blob.generate-client-token";

export function createUploadHandler(kind) {
  const config = KINDS[kind];

  return {
    async fetch(request) {
      if (request.method.toUpperCase() !== "POST") {
        return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
      }

      const denied = await requireAdmin(request);
      if (denied) return denied;

      if (!blobConfigured()) {
        return fail(
          503,
          "The Vercel Blob store is not connected yet. Create a Blob store in your Vercel project, then redeploy."
        );
      }

      const body = await readJson(request);
      if (!body) return fail(400, "Invalid JSON body.");

      if (body.type === TOKEN_EVENT) {
        try {
          const response = await handleUpload({
            body,
            request,
            onBeforeGenerateToken: async (pathname, clientPayload) => {
              if (!parseMediaPathname(kind, pathname)) {
                throw new Error("That upload path is not allowed.");
              }
              assertPayload(kind, clientPayload);
              return {
                allowedContentTypes: config.contentTypes,
                maximumSizeInBytes: config.maxBytes,
                addRandomSuffix: false,
                allowOverwrite: false,
              };
            },
          });
          return json(response);
        } catch (error) {
          return fail(400, error?.message || "Could not start the upload.");
        }
      }

      if (body.finalize === true) return finalizeUpload(kind, body);

      return fail(400, "Unsupported upload request.");
    },
  };
}

/** Reject an obviously unusable label before issuing a token. */
function assertPayload(kind, clientPayload) {
  const payload = parsePayload(clientPayload);
  if (!payload) return;
  if (!payload.filename) throw new Error("The upload is missing a file name.");
  if (kind === "video" && payload.category && cleanText(payload.category, 60).length === 0) {
    throw new Error("The upload is missing a skill category.");
  }
}

function parsePayload(clientPayload) {
  if (typeof clientPayload !== "string" || clientPayload === "") return null;
  try {
    const parsed = JSON.parse(clientPayload);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Step 2: confirm the file exists in the store, then write its record. */
async function finalizeUpload(kind, body) {
  const parsed = parseMediaPathname(kind, body.pathname);
  if (!parsed) return fail(400, "Unexpected upload path.");

  const filename = cleanText(body.filename, 200) || `${parsed.id}.${parsed.extension}`;

  let meta;
  try {
    meta = await head(body.pathname);
  } catch {
    meta = null;
  }
  if (!meta) {
    return fail(409, "That upload could not be found in storage — please try uploading again.");
  }

  const record = {
    id: parsed.id,
    kind: kind === "video" ? "file" : "photo",
    filename,
    pathname: body.pathname,
    url: meta.url,
    size: Number(meta.size) || 0,
    addedAt: new Date().toISOString(),
  };

  if (kind === "video") {
    record.category = cleanText(body.category, 60) || "General";
  } else {
    record.type = body.type === "mistress" ? "mistress" : "head";
  }

  await writeRecord(kind, record);

  return json({ success: true, key: parsed.id, ...record });
}
