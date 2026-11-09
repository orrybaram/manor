/**
 * pdf.js, opening a PDF from its bytes. Imported only when one is open: it is
 * its own chunk, as CodeMirror is. The legacy build, so a phone's older Safari
 * can read one too.
 */

import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Emitted beside the app by `scripts/vite-pdfjs-assets.ts`. */
const asset = (folder: string) => new URL(`pdfjs/${folder}/`, document.baseURI).href;

export type OpenPdf = {
  doc: PDFDocumentProxy;
  /** The first page's width over its height, until a page knows its own. */
  aspect: number;
};

export async function openPdf(base64: string): Promise<OpenPdf> {
  const binary = atob(base64);
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  const task = getDocument({
    data,
    // Decoders for what scanned pages are stored as, and the data a PDF may
    // lean on rather than embed. Without them those pages draw blank, silently.
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
    cMapUrl: asset("cmaps"),
    standardFontDataUrl: asset("standard_fonts"),
  });
  try {
    const doc = await task.promise;
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    return { doc, aspect: first.width / first.height };
  } catch (err) {
    // Its worker would outlive the failure.
    void task.destroy();
    throw err;
  }
}
