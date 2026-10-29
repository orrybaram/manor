import { describe, expect, it } from "vitest";
import { createLinkHoverTracker } from "../link-hover";

const ev = {} as MouseEvent;

describe("createLinkHoverTracker", () => {
  it("holds the hovered link until the pointer leaves it", () => {
    const t = createLinkHoverTracker();
    expect(t.current()).toBeNull();
    t.hover(ev, "http://localhost:5173/");
    expect(t.current()).toBe("http://localhost:5173/");
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
