import { describe, it, expect, vi } from "vitest";
import { localCtx } from "../../method";
import { chatKey } from "../chat";

function setup() {
  const write = vi.fn();
  const ctx = localCtx({ backend: { pty: { write } } } as never);
  return { write, ctx };
}

describe("chat.key (ADR-218 D3)", () => {
  const cases: [string, string][] = [
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["left", "\x1b[D"],
    ["right", "\x1b[C"],
    ["enter", "\r"],
    ["esc", "\x1b"],
    ["tab", "\t"],
    ["space", " "],
  ];

  it.each(cases)("writes %s as its sequence", (key, bytes) => {
    const { write, ctx } = setup();
    chatKey(ctx, "p1", key as never);
    expect(write).toHaveBeenCalledWith("p1", bytes);
  });

  it("throws on an unknown key without writing", () => {
    const { write, ctx } = setup();
    expect(() => chatKey(ctx, "p1", "toString" as never)).toThrow(/key/);
    expect(() => chatKey(ctx, "p1", "f5" as never)).toThrow(/key/);
    expect(() => chatKey(ctx, "p1", 3 as never)).toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
