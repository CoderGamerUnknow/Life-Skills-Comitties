/**
 * Sanity check: find CSS classes referenced in HTML or JS that have no rule in
 * public/css/style.css. Catches classes orphaned by a stylesheet rewrite.
 *
 * Usage: node tools/check-classes.mjs
 * Exits 1 if any used class is undefined (state-change classes are exempt).
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");

// Classes toggled purely as JS state hooks, or built by string concat (toast-*
// ). These don't need their own rule to be correct.
const STATE_ONLY = new Set(["active", "show", "video", "image-placeholder", "placeholder"]);

const files = [];
for (const f of await readdir(join(PUBLIC))) if (f.endsWith(".html")) files.push(join(PUBLIC, f));
for (const f of await readdir(join(PUBLIC, "js"))) if (f.endsWith(".js")) files.push(join(PUBLIC, "js", f));

const used = new Set();
const classAttr = /class="([^"]+)"/g;
const classNameEq = /className\s*=\s*"([^"]+)"/g;
const classNamePlus = /className\s*\+=\s*"([^"]+)"/g;
const classListAdd = /classList\.(?:add|toggle|remove)\(\s*"([^"]+)"/g;

for (const path of files) {
  const src = await readFile(path, "utf8");
  for (const re of [classAttr, classNameEq, classNamePlus, classListAdd]) {
    let m;
    while ((m = re.exec(src))) {
      for (const c of m[1].split(/\s+/)) {
        const name = c.replace(/\$\{[^}]*\}/g, "").trim();
        // Skip fragments from string concatenation, e.g. "toast-msg toast-" + type.
        if (!name || name.endsWith("-")) continue;
        if (/^[a-zA-Z][\w-]*$/.test(name)) used.add(name);
      }
    }
  }
}

const css = await readFile(join(PUBLIC, "css", "style.css"), "utf8");
const defined = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) defined.add(m[1]);

const missing = [...used].filter((c) => !defined.has(c) && !STATE_ONLY.has(c)).sort();

if (missing.length) {
  console.log("Classes used but NOT defined in style.css:");
  for (const c of missing) console.log("  - " + c);
  process.exit(1);
}
console.log(`OK — all ${used.size} referenced classes are defined.`);
