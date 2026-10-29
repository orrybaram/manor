import { describe, expect, it } from "vitest";
import { createLinkHoverTracker } from "../link-hover";

const ev = {} as MouseEvent;

describe("createLinkHoverTracker", () => {
  it("holds the hovered link until the pointer leaves it", () => {
    const t = createLinkHoverTracker();
    expect(t.current()).toBeNull();
    t.hover(ev, "http://localhost:5173/");
    expect(t.current()).toEqual({ kind: "url", url: "http://localhost:5173/" });
    t.leave();
    expect(t.current()).toBeNull();
  });

  it("holds a hovered file link with its line", () => {
    const t = createLinkHoverTracker();
    t.hoverFile({ kind: "file", path: "src/foo.ts", line: 12 });
    expect(t.current()).toEqual({ kind: "file", path: "src/foo.ts", line: 12 });
    t.leave();
    expect(t.current()).toBeNull();
  });

  it("forgets the link when its terminal goes without a leave", () => {
    const t = createLinkHoverTracker();
    t.hover(ev, "http://localhost:5173/");
    t.clear();
    expect(t.current()).toBeNull();
  });
});
