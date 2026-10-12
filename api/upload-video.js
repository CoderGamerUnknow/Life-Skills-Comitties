/**
 * POST /api/upload-video — step 1 (token) and step 2 (record) of a video upload.
 * See lib/upload-handler.js for the flow.
 */

import { createUploadHandler } from "../lib/upload-handler.js";

export default createUploadHandler("video");
