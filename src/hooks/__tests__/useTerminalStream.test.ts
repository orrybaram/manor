// @vitest-environment jsdom
/**
 * The re-attach a bridge resync runs in place (ADR-220 D3), as far as
 * `useTerminalStream` owns it: `closeOutput` queues output again, and
 * `openRestored(..., { replace: true })` swaps the old screen for the fresh
 * snapshot plus the chunks it does not cover — no line twice, none missing.
 *
 * Driven against a fake `pty` bridge and a real headless emulator. The
 * orchestration around it in `useTerminalLifecycle` (the second `pty.create`,
 * the in-flight guard) needs a real xterm with its DOM and render add-ons,
 * which jsdom can't open, so it is not covered here.
 */

import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { Terminal } from "@xterm/xterm";
import { useTerminalStream } from "../useTerminalStream";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PANE = "pane-1";

type OutputListener = (data: string, seq?: number) => void;

let output: OutputListener | null;
let container: HTMLDivElement;
let root: Root;
let stream: ReturnType<typeof useTerminalStream>;

function installPty(): void {
  output = null;
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
      onExit: noop,
      onCwd: noop,
      onError: noop,
    },
  };
}

function Harness({ term }: { term: Terminal }) {
  const s = useTerminalStream(PANE, term);
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

describe("useTerminalStream — re-attach in place", () => {
  it("replaces the screen with the snapshot plus only what follows it", async () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true });
    act(() => root.render(createElement(Harness, { term: term as unknown as Terminal })));

    // First attach: a snapshot at seq 2, and a chunk it already covers.
    output?.("two\r\n", 2);
    stream.openRestored(term as unknown as Terminal, { ansi: "one\r\ntwo\r\n", seq: 2 });
    output?.("three\r\n", 3);
    await flush(term);
    expect(lines(term)).toEqual(["one", "two", "three"]);

    // The socket dropped: seq 4 and 5 were printed and never arrived. Resync.
    stream.closeOutput();
    output?.("five\r\n", 5); // the replayed subscription, before the reply
    output?.("six\r\n", 6);
    stream.openRestored(
      term as unknown as Terminal,
      { ansi: "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n", seq: 5 },
      { replace: true },
    );
    output?.("seven\r\n", 7);
    await flush(term);

    expect(lines(term)).toEqual(["one", "two", "three", "four", "five", "six", "seven"]);
  });

  it("holds output while the re-attach is in flight", async () => {
    const term = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true });
    act(() => root.render(createElement(Harness, { term: term as unknown as Terminal })));
    stream.openRestored(term as unknown as Terminal, null);
    stream.closeOutput();
    output?.("held\r\n", 1);
    await flush(term);
    expect(lines(term)).toEqual([]);

    // A failed re-attach lets it through as it came.
    stream.openRestored(term as unknown as Terminal);
    await flush(term);
    expect(lines(term)).toEqual(["held"]);
  });
});
