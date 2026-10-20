import { afterEach, describe, it, expect, vi } from "vitest";
import { localCtx } from "../../method";
import { chatTaskKey } from "../../../chat-mirror/task-key";
import { chatInterrupt, chatKey, chatSend, wireChatMirror } from "../chat";

function setup() {
  const write = vi.fn();
  const ctx = localCtx({ backend: { pty: { write } } } as never);
  return { write, ctx };
}

describe("chat.key", () => {
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

describe("wireChatMirror subscriptions", () => {
  function wire(subscribed: Set<string>) {
    const chatMirror = { setWatched: vi.fn(), setTaskWatched: vi.fn(), agentChanged: vi.fn() };
    let change: (name: string, key: string) => void = () => {};
    const off = wireChatMirror({ chatMirror: chatMirror as never }, {
      onSubscriptionChange: (cb) => {
        change = cb;
        return () => {};
      },
      hasSubscriber: (ns, event, key) => subscribed.has(`${ns}.${event}@${key}`),
    }, () => () => {});
    return { chatMirror, change: (name: string, key: string) => change(name, key), off };
  }

  it("watches a pane's chat while chat.entry has a subscriber", () => {
    const subscribed = new Set(["chat.entry@p1"]);
    const { chatMirror, change, off } = wire(subscribed);
    change("chat.entry", "p1");
    subscribed.clear();
    change("chat.entry", "p1");
    expect(chatMirror.setWatched.mock.calls).toEqual([
      ["p1", true],
      ["p1", false],
    ]);
    off();
  });

  it("watches one task's transcript while its chat.taskEntry key has a subscriber", () => {
    const key = chatTaskKey("p1", "toolu_1");
    const subscribed = new Set([`chat.taskEntry@${key}`]);
    const { chatMirror, change, off } = wire(subscribed);
    change("chat.taskEntry", key);
    subscribed.clear();
    change("chat.taskEntry", key);
    // A key that names no task is ignored.
    change("chat.taskEntry", "p1");
    expect(chatMirror.setTaskWatched.mock.calls).toEqual([
      ["p1", "toolu_1", true],
      ["p1", "toolu_1", false],
    ]);
    expect(chatMirror.setWatched).not.toHaveBeenCalled();
    off();
  });

  it("forwards a remote pane's subscription to its host instead of watching it here", () => {
    const subscribed = new Set(["chat.entry@remote-pane", `chat.taskEntry@${chatTaskKey("remote-pane", "t1")}`]);
    const chatMirror = { setWatched: vi.fn(), setTaskWatched: vi.fn(), agentChanged: vi.fn() };
    let change: (name: string, key: string) => void = () => {};
    const release = vi.fn();
    const watchChat = vi.fn(() => release);
    const off = wireChatMirror(
      { chatMirror: chatMirror as never },
      {
        onSubscriptionChange: (cb) => {
          change = cb;
          return () => {};
        },
        hasSubscriber: (ns, event, key) => subscribed.has(`${ns}.${event}@${key}`),
      },
      () => () => {},
      { proxyForPane: (paneId) => (paneId === "remote-pane" ? { watchChat } : null) },
    );

    change("chat.entry", "remote-pane");
    // Another viewer joining the same key does not forward it twice.
    change("chat.entry", "remote-pane");
    change("chat.taskEntry", chatTaskKey("remote-pane", "t1"));
    expect(watchChat.mock.calls).toEqual([
      ["entry", "remote-pane"],
      ["taskEntry", chatTaskKey("remote-pane", "t1")],
    ]);

    subscribed.delete("chat.entry@remote-pane");
    change("chat.entry", "remote-pane");
    expect(release).toHaveBeenCalledTimes(1);
    // A pane the desktop runs itself is still watched here.
    subscribed.add("chat.entry@local-pane");
    change("chat.entry", "local-pane");
    expect(chatMirror.setWatched.mock.calls).toEqual([["local-pane", true]]);
    expect(chatMirror.setTaskWatched).not.toHaveBeenCalled();

    off();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
