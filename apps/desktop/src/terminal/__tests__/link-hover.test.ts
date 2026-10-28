import { describe, expect, it } from "vitest";
import { createLinkHoverTracker } from "../link-hover";

const ev = {} as MouseEvent;

describe("createLinkHoverTracker", () => {
  it("holds the hovered link until the pointer leaves it", () => {
    const t = createLinkHoverTracker();
    expect(t.current()).toBeNull();
    t.hover(ev, "http://localhost:5173/");
    expect(t.current()).toBe("http://localhost:5173/");
    t.leave(ev, "http://localhost:5173/");
    expect(t.current()).toBeNull();
  });

  it("keeps the new link when the old one's leave comes after its hover", () => {
    const t = createLinkHoverTracker();
    t.hover(ev, "https://a.example/");
    t.hover(ev, "https://b.example/");
    t.leave(ev, "https://a.example/");
    expect(t.current()).toBe("https://b.example/");
  });
});
