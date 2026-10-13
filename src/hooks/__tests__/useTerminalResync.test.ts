// @vitest-environment jsdom
/**
 * A bridge resync remounts every open terminal for reason `resync` — once per
 * window, whatever the number of panes (ADR-220 D3).
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const listeners = new Set<() => void>();
vi.mock("../../bridge/resync", () => ({
  onBridgeResync: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));

import { useTerminalResync } from "../useTerminalResync";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal-registry";
import { useRemotePaneStore } from "../../store/remote-pane-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useTerminalResync();
  return null;
}

let root: Root;
const resync = () => {
  for (const cb of listeners) cb();
};
const term = {} as Terminal;

beforeEach(() => {
  useRemotePaneStore.setState({ panes: {} });
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  unregisterTerminal("pane-a");
  unregisterTerminal("pane-b");
});

describe("useTerminalResync", () => {
  it("remounts the open terminals, and only those, for a resync", () => {
    registerTerminal("pane-a", term);
    registerTerminal("pane-b", term);
    resync();
    const store = useRemotePaneStore.getState();
    expect(store.panes["pane-a"]?.reattachEpoch).toBe(1);
    expect(store.consumeReattach("pane-a")).toBe("resync");
    expect(store.consumeReattach("pane-b")).toBe("resync");
    expect(store.consumeReattach("pane-c")).toBeNull();
  });

  it("subscribes once, and lets go on unmount", () => {
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(document.createElement("div"));
  });
});
