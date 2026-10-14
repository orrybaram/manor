// @vitest-environment jsdom
/**
 * A bridge resync remounts every open terminal for reason `resync` — once per
 * window, whatever the number of panes (ADR-220 D3) — or, for one host's own
 * bridge, that host's (ADR-228 D1, D4).
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";

const listeners = new Set<(serverId?: string) => void>();
vi.mock("../../bridge/resync", () => ({
  onBridgeResync: (cb: (serverId?: string) => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));

import { useTerminalResync } from "../useTerminalResync";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal-registry";
import { useRemotePaneStore } from "../../store/remote-pane-store";
import { useHostStore, type HostStatusInfo } from "../../store/host-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  useTerminalResync();
  return null;
}

let root: Root;
const resync = (serverId?: string) => {
  for (const cb of listeners) cb(serverId);
};
const box = (status: HostStatusInfo["status"]): HostStatusInfo => ({
  hostId: "box",
  spec: { kind: "ssh", target: "box" },
  status,
});
const term = {} as Terminal;

beforeEach(() => {
  useRemotePaneStore.setState({ panes: {} });
  useHostStore.setState({ hosts: [box("connected")] });
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

  it("remounts only a host's panes for its own bridge, and none after the host was away", () => {
    registerTerminal("pane-a", term);
    registerTerminal("pane-b", term);
    useRemotePaneStore.getState().setPaneHost("pane-b", "box");
    resync("box");
    let store = useRemotePaneStore.getState();
    expect(store.consumeReattach("pane-a")).toBeNull();
    expect(store.consumeReattach("pane-b")).toBe("resync");

    // The host dropped and is back: its recovery remounts its panes instead.
    act(() => useHostStore.setState({ hosts: [box("reconnecting")] }));
    act(() => useHostStore.setState({ hosts: [box("connected")] }));
    resync("box");
    store = useRemotePaneStore.getState();
    expect(store.consumeReattach("pane-b")).toBeNull();
    // Only that once.
    resync("box");
    expect(useRemotePaneStore.getState().consumeReattach("pane-b")).toBe("resync");
  });

  it("subscribes once, and lets go on unmount", () => {
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
    root = createRoot(document.createElement("div"));
  });
});
