import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * pdf.js's data files, emitted to `pdfjs/` in a build: the decoders for images
 * in scanned PDFs, and the fonts, character maps and colour profiles a PDF may
 * not embed (`pdf-document.ts`). pdf.js asks for them by name, so they can't
 * be hashed imports. Not served by the dev server, where those PDFs draw
 * incompletely. QuickJS is left out: it only runs a PDF's own scripts, which
 * this viewer doesn't.
 */
export function pdfjsAssets(): Plugin {
  const root = path.dirname(createRequire(__filename).resolve("pdfjs-dist/package.json"));
  return {
    name: "pdfjs-assets",
    apply: "build",
    generateBundle() {
      for (const folder of ["wasm", "iccs", "cmaps", "standard_fonts"]) {
        for (const name of readdirSync(path.join(root, folder))) {
          if (/quickjs/i.test(name)) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${folder}/${name}`,
            source: readFileSync(path.join(root, folder, name)),
          });
        }
      }
    },
  };
}
