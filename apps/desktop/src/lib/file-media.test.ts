import { describe, expect, it } from "vitest";
import { fileMedia } from "./file-media";

describe("fileMedia", () => {
  it("knows images and PDFs by extension, whatever its case", () => {
    expect(fileMedia("assets/logo.PNG")).toEqual({ kind: "image", mimeType: "image/png" });
    expect(fileMedia("/tmp/a.b/photo.jpeg")).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(fileMedia("docs/spec.pdf")).toEqual({ kind: "pdf" });
  });

  it("leaves everything else to the editor", () => {
    expect(fileMedia("logo.svg")).toBeNull();
    expect(fileMedia("src/a.ts")).toBeNull();
    // The extension is the file's, not a folder's.
    expect(fileMedia("pictures.png/README")).toBeNull();
    expect(fileMedia("png")).toBeNull();
  });
});
