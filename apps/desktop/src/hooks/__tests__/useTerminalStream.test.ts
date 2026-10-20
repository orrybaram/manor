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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANE = "pane-1";

type OutputListener = (data: string, seq?: number) => void;

let output: OutputListener | null;
let exit: (() => void) | null;
let container: HTMLDivElement;
let root: Root;
let stream: ReturnType<typeof useTerminalStream>;

function installPty(): void {
  output = null;
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
      onResized: noop,
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
}: {
  term: Terminal;
  resetting?: boolean;
}) {
  const s = useTerminalStream(PANE, term, undefined, { current: resetting });
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
