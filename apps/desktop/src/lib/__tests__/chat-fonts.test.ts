import { describe, expect, it } from "vitest";
import { BUNDLED_CHAT_FONTS, chatFontStack } from "../chat-fonts";

describe("chatFontStack", () => {
  it("leaves the default to the app's own font", () => {
    expect(chatFontStack("")).toBe("inherit");
    expect(chatFontStack("   ")).toBe("inherit");
  });

  it("offers five bundled families, each with a fallback of its kind", () => {
    expect(BUNDLED_CHAT_FONTS).toHaveLength(5);
    expect(chatFontStack("Literata")).toBe('"Manor Chat Literata", Georgia, serif');
    expect(chatFontStack("JetBrains Mono")).toBe('"Manor Chat JetBrains Mono", var(--font-mono)');
  });

  it("falls back to the system font for an installed family a phone may lack", () => {
    expect(chatFontStack("Comic Sans MS")).toMatch(/^"Comic Sans MS", .*sans-serif$/);
  });

  it("keeps a stored name from breaking out of the stack", () => {
    expect(chatFontStack('Evil"; color: red')).toMatch(/^"Evil; color: red", /);
  });
});
