// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { beginPointerTracking, hasPointerLeftDocument } from "../detach-drag";

describe("pointer-left-the-app tracking", () => {
  it("treats the pointer as inside the app right after dragstart", () => {
    beginPointerTracking();
    expect(hasPointerLeftDocument()).toBe(false);
  });

  it("stays inside while the document keeps receiving dragover", () => {
    beginPointerTracking();
    const later = performance.now() + 2000;
    document.dispatchEvent(new Event("dragover"));
    expect(hasPointerLeftDocument(performance.now())).toBe(false);
    // Long after the last dragover, the drag has left the document.
    expect(hasPointerLeftDocument(later)).toBe(true);
  });

  it("reports left once dragover has gone quiet", () => {
    beginPointerTracking();
    expect(hasPointerLeftDocument(performance.now() + 1000)).toBe(true);
  });
});
