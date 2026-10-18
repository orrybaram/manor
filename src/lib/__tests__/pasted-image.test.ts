import { describe, it, expect } from "vitest";
import { pastedImageExtension } from "../pasted-image";

describe("pastedImageExtension", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
  ])("maps %s to %s", (mime, ext) => {
    expect(pastedImageExtension(mime)).toBe(ext);
  });

  it("returns null for types it does not accept", () => {
    expect(pastedImageExtension("image/svg+xml")).toBeNull();
    expect(pastedImageExtension("text/plain")).toBeNull();
    expect(pastedImageExtension("")).toBeNull();
  });

  it("does not treat inherited object keys as types", () => {
    expect(pastedImageExtension("toString")).toBeNull();
    expect(pastedImageExtension("__proto__")).toBeNull();
  });
});
