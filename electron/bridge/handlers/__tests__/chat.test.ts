import { afterEach, describe, it, expect, vi } from "vitest";
import { localCtx } from "../../method";
import { chatInterrupt, chatKey, chatSend } from "../chat";

function setup() {
  const write = vi.fn();
  const ctx = localCtx({ backend: { pty: { write } } } as never);
  return { write, ctx };
}

describe("chat.key (ADR-218 D3)", () => {
  const cases: [string, string][] = [
    ["up", "\x1b[A"],
    ["down", "\x1b[B"],
    ["enter", "\r"],
    ["esc", "\x1b"],
    ["tab", "\t"],
  ];

  it.each(cases)("writes %s as its sequence", async (key, bytes) => {
    const { write, ctx } = setup();
    await chatKey(ctx, "p1", key as never);
    expect(write).toHaveBeenCalledWith("p1", bytes);
  });

  it("throws on an unknown or removed key without writing", () => {
    const { write, ctx } = setup();
    expect(() => chatKey(ctx, "p1", "toString" as never)).toThrow(/key/);
    expect(() => chatKey(ctx, "p1", "f5" as never)).toThrow(/key/);
    expect(() => chatKey(ctx, "p1", "space" as never)).toThrow(/key/);
    expect(() => chatKey(ctx, "p1", 3 as never)).toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("serialized per-pane writes", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps two concurrent sends to one pane in order", async () => {
    vi.useFakeTimers();
    const { write, ctx } = setup();
    const a = chatSend(ctx, "p1", "A");
    const b = chatSend(ctx, "p1", "B");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([a, b]);
    expect(write.mock.calls).toEqual([
      ["p1", "A"],
      ["p1", "\r"],
      ["p1", "B"],
      ["p1", "\r"],
    ]);
  });

  it("lands a key and an interrupt after an in-flight send's submit", async () => {
    vi.useFakeTimers();
    const { write, ctx } = setup();
    const send = chatSend(ctx, "p1", "A");
    const key = chatKey(ctx, "p1", "up");
    const stop = chatInterrupt(ctx, "p1");
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([send, key, stop]);
    expect(write.mock.calls).toEqual([
      ["p1", "A"],
      ["p1", "\r"],
      ["p1", "\x1b[A"],
      ["p1", "\x1b"],
    ]);
  });

  it("does not block other panes", async () => {
    vi.useFakeTimers();
    const { write, ctx } = setup();
    const a = chatSend(ctx, "p1", "A");
    const k = chatKey(ctx, "p2", "enter");
    await vi.advanceTimersByTimeAsync(0);
    await k;
    expect(write.mock.calls).toEqual([
      ["p1", "A"],
      ["p2", "\r"],
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    await a;
  });

  it("keeps the queue going after a failed write", async () => {
    const { write, ctx } = setup();
    write.mockImplementationOnce(() => {
      throw new Error("gone");
    });
    await expect(chatKey(ctx, "p1", "up")).rejects.toThrow("gone");
    await chatKey(ctx, "p1", "down");
    expect(write).toHaveBeenLastCalledWith("p1", "\x1b[B");
  });
});
