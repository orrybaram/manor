// @vitest-environment jsdom
/**
 * The attach a bridge resync remounts a pane for, as far as
 * `useTerminalStream` owns it: the fresh mount queues output until
 * `openRestored` writes the snapshot plus only the chunks it does not cover,
 * and `sessionEnded` — a missed `exit`, or the attach finding the session
 * gone — lets queued output through and closes the pane unless it is being
 * reset.
 *
 * Driven against a fake `pty` bridge and a real headless emulator. The
 * remount itself in `useTerminalLifecycle` needs a real xterm with its DOM
 * and render add-ons, which jsdom can't open, so it is not covered here.
 */

import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import { useTerminalStream } from "../useTerminalStream";
import { useAppStore } from "../../store/app-store";
import type { PtyAttachResult } from "../../electron.d";
import { HOLD_LIMIT_CHARS, HOLD_SWITCH_KEY } from "../../lib/held-output";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANE = "pane-1";

type OutputListener = (data: string, seq?: number) => void;

let output: OutputListener | null;
let resized: ((cols: number, rows: number) => void) | null;
let exit: (() => void) | null;
let container: HTMLDivElement;
let root: Root;
let stream: ReturnType<typeof useTerminalStream>;

function installPty(): void {
  output = null;
  resized = null;
  exit = null;
  const noop = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: {
      onOutput: (_paneId: string, cb: OutputListener) => {
        output = cb;
        return () => {
          output = null;
        };
      },
      onResized: (_paneId: string, cb: (cols: number, rows: number) => void) => {
        resized = cb;
        return () => {
          resized = null;
        };
      },
      onExit: (_paneId: string, cb: () => void) => {
        exit = cb;
        return () => {
          exit = null;
        };
      },
      onCwd: noop,
      onError: noop,
    },
  };
}

function Harness({
  term,
  resetting = false,
  shown,
  attach,
}: {
  term: Terminal;
  resetting?: boolean;
  shown?: boolean;
  attach?: () => Promise<PtyAttachResult>;
}) {
  const s = useTerminalStream(PANE, term, undefined, { current: resetting }, { shown, attach });
  useLayoutEffect(() => {
    stream = s;
  });
  return null;
}

const flush = (term: HeadlessTerminal) =>
  new Promise<void>((resolve) => term.write("", () => resolve()));

function lines(term: HeadlessTerminal): string[] {
  const buf = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i)?.translateToString(true) ?? "";
    if (line) out.push(line);
  }
  return out;
}

beforeEach(() => {
  installPty();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

const headless = () =>
  new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true });

describe("useTerminalStream — a resync's remount", () => {
  it("draws the fresh snapshot plus only what follows it", async () => {
    // The remount's terminal is a new one: the old screen went with the old.
    const term = headless();
    act(() => root.render(createElement(Harness, { term: term as unknown as Terminal })));

    // The replayed subscription delivers seq 5 and 6 before the attach's
    // reply, whose snapshot already holds everything up to 5.
    output?.("five\r\n", 5);
    output?.("six\r\n", 6);
    await flush(term);
    expect(lines(term)).toEqual([]);

    stream.openRestored(term as unknown as Terminal, {
      ansi: "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n",
      seq: 5,
    });
    output?.("seven\r\n", 7);
    await flush(term);

    expect(lines(term)).toEqual(["one", "two", "three", "four", "five", "six", "seven"]);
  });
});

describe("useTerminalStream — sessionEnded", () => {
  const closePaneById = vi.fn();
  beforeEach(() => {
    closePaneById.mockReset();
    useAppStore.setState({ closePaneById });
  });

  it("closes the pane on a missed exit, letting queued output through", async () => {
    const term = headless();
    act(() => root.render(createElement(Harness, { term: term as unknown as Terminal })));
    output?.("bye\r\n", 1);

    stream.sessionEnded(term as unknown as Terminal);
    await flush(term);

    expect(lines(term)).toEqual(["bye"]);
    expect(closePaneById).toHaveBeenCalledWith(PANE);
  });

  it("is what the exit event does", () => {
    const term = headless();
    act(() => root.render(createElement(Harness, { term: term as unknown as Terminal })));
    exit?.();
    expect(closePaneById).toHaveBeenCalledWith(PANE);
  });

  it("keeps a pane being reset open, with its output flowing", async () => {
    const term = headless();
    act(() =>
      root.render(
        createElement(Harness, { term: term as unknown as Terminal, resetting: true }),
      ),
    );
    output?.("held\r\n", 1);

    stream.sessionEnded();
    output?.("fresh\r\n", 2);
    await flush(term);

    expect(lines(term)).toEqual(["held", "fresh"]);
    expect(closePaneById).not.toHaveBeenCalled();
  });
});

describe("useTerminalStream — a pane off screen holds its output", () => {
  const attachOk = (snapshot: string, snapshotSeq: number) =>
    vi.fn(async (): Promise<PtyAttachResult> => ({ ok: true, hostId: "local", snapshot, snapshotSeq }));

  function mount(term: HeadlessTerminal, shown: boolean, attach = attachOk("", 0)) {
    act(() =>
      root.render(createElement(Harness, { term: term as unknown as Terminal, shown, attach })),
    );
    act(() => stream.openRestored(term as unknown as Terminal));
    return attach;
  }
  const show = (term: HeadlessTerminal, shown: boolean, attach?: () => Promise<PtyAttachResult>) =>
    act(() =>
      root.render(
        createElement(Harness, { term: term as unknown as Terminal, shown, attach: attach ?? attachOk("", 0) }),
      ),
    );

  it("writes nothing while hidden, then everything in order on show", async () => {
    const term = headless();
    mount(term, false);
    output?.("one\r\n", 1);
    resized?.(30, 10);
    output?.("two\r\n", 2);
    await flush(term);
    expect(lines(term)).toEqual([]);
    expect(stream.heldSize()).toEqual({ chars: 10, overflowed: false });

    show(term, true);
    await flush(term);
    expect(lines(term)).toEqual(["one", "two"]);
    expect(term.cols).toBe(30);
    expect(stream.heldSize()).toBeNull();
    output?.("three\r\n", 3);
    await flush(term);
    expect(lines(term)).toEqual(["one", "two", "three"]);
  });

  it("catches up at once when held output asks a query, and goes on holding", async () => {
    const term = headless();
    const replies: string[] = [];
    term.onData((d) => replies.push(d));
    mount(term, false);
    output?.("before\r\n", 1);
    output?.("\x1b[6n", 2);
    await flush(term);
    expect(lines(term)).toEqual(["before"]);
    expect(replies).toEqual(["\x1b[2;1R"]);
    output?.("after\r\n", 3);
    await flush(term);
    expect(lines(term)).toEqual(["before"]);
    expect(stream.heldSize()?.chars).toBe(7);
  });

  it("applies a held title without catching up", async () => {
    const term = headless();
    mount(term, false);
    output?.("\x1b]0;✳ Fixing tests\x07working\r\n", 1);
    await flush(term);
    expect(useAppStore.getState().paneTitle[PANE]).toBe("✳ Fixing tests");
    expect(lines(term)).toEqual([]);
  });

  it("catches up on catchUp() while still hidden", async () => {
    const term = headless();
    mount(term, false);
    output?.("typed-into\r\n", 1);
    act(() => stream.catchUp());
    await flush(term);
    expect(lines(term)).toEqual(["typed-into"]);
    expect(stream.heldSize()).toEqual({ chars: 0, overflowed: false });
  });

  it("past the hold limit, restores from the snapshot instead of replaying", async () => {
    const term = headless();
    mount(term, false);
    output?.("old screen\r\n", 1);
    act(() => stream.catchUp());
    const big = "y\r\n".repeat(Math.ceil(HOLD_LIMIT_CHARS / 3) + 1);
    output?.(big, 2);
    expect(stream.heldSize()).toEqual({ chars: 0, overflowed: true });

    // The snapshot covers up to 3; 3 arrives during the round trip, 4 after it.
    let answer!: (r: PtyAttachResult) => void;
    const attach = vi.fn(() => new Promise<PtyAttachResult>((r) => (answer = r)));
    show(term, true, attach);
    expect(attach).toHaveBeenCalledTimes(1);
    output?.("three\r\n", 3);
    output?.("four\r\n", 4);
    await flush(term);
    // The old screen stays up until the snapshot lands.
    expect(lines(term)).toEqual(["old screen"]);
    await act(async () => answer({ ok: true, hostId: "local", snapshot: "snap\r\nthree\r\n", snapshotSeq: 3 }));
    await flush(term);
    expect(lines(term)).toEqual(["snap", "three", "four"]);
  });

  it("lets held output through when the session ends while hidden", async () => {
    const term = headless();
    mount(term, false);
    output?.("last words\r\n", 1);
    act(() => exit?.());
    await flush(term);
    expect(lines(term)).toEqual(["last words"]);
  });

  it("holds nothing with the kill switch off", async () => {
    localStorage.setItem(HOLD_SWITCH_KEY, "off");
    try {
      const term = headless();
      mount(term, false);
      output?.("live\r\n", 1);
      await flush(term);
      expect(lines(term)).toEqual(["live"]);
      expect(stream.heldSize()).toBeNull();
    } finally {
      localStorage.removeItem(HOLD_SWITCH_KEY);
    }
  });

  it("holds while the window is hidden, though the pane is shown", async () => {
    const term = headless();
    let state: DocumentVisibilityState = "hidden";
    const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
    try {
      mount(term, true);
      output?.("behind\r\n", 1);
      await flush(term);
      expect(lines(term)).toEqual([]);
      state = "visible";
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await flush(term);
      expect(lines(term)).toEqual(["behind"]);
    } finally {
      spy.mockRestore();
    }
  });
});
