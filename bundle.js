/**
 * Bundle the worker for Sites deploy.
 *
 * The deploy pipeline uploads prebuilt Worker code as-is — it does not
 * bundle npm dependencies, so `jose` must be inlined here.
 *
 * Usage: npm run build   (or: node bundle.js)
 * Output: dist/worker.js  (referenced by manifest.json)
 */

import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, "src/worker.js")],
  bundle: true,
  outfile: join(__dirname, "dist/worker.js"),
  format: "esm",
  platform: "neutral",
  target: ["es2022"],
  mainFields: ["module", "main"],
  conditions: ["worker", "browser", "import", "default"],
  external: [],
  logLevel: "info",
  sourcemap: false,
  minify: false,
});
console.log("Bundled -> dist/worker.js");
