// @vitest-environment jsdom
/**
 * A pane waiting for its host is created again once the host is reachable —
 * including when the host already read `connected` as it was told to wait:
 * on an adopted host its create goes through the host server, whose owner
 * channel comes up after the host's own connection does.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../bridge/server-set", () => ({
  whenDirectSettled: () => Promise.resolve(),
}));
vi.mock("../../lib/remote-recovery", async (importActual) => ({
  ...(await importActual<typeof import("../../lib/remote-recovery")>()),
  windowPaneIds: () => new Set(["pane-a"]),
}));

import { useRemoteRecovery } from "../useRemoteRecovery";
import { useRemotePaneStore } from "../../store/remote-pane-store";
import { useHostStore, type HostStatusInfo } from "../../store/host-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ServerChange = { hostId: string; state: string };
const serverListeners = new Set<(info: ServerChange) => void>();

function Harness() {
  useRemoteRecovery();
  return null;
}

let root: Root;
const box = (status: HostStatusInfo["status"]): HostStatusInfo => ({
  hostId: "box",
  spec: { kind: "ssh", target: "box" },
  status,
});
const serverChanged = async (state: string) => {
  for (const cb of serverListeners) cb({ hostId: "box", state });
  await act(async () => {});
};

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    hosts: {
      onReconnected: () => () => {},
      onServerChanged: (cb: (info: ServerChange) => void) => {
        serverListeners.add(cb);
        return () => serverListeners.delete(cb);
      },
    },
  };
  useRemotePaneStore.setState({ panes: {} });
  useHostStore.setState({ hosts: [box("connecting")] });
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useRemoteRecovery", () => {
  it("creates a waiting pane again when its host connects", async () => {
    useRemotePaneStore.getState().awaitHost("pane-a", "box");
    act(() => useHostStore.setState({ hosts: [box("connected")] }));
    await act(async () => {});
    expect(useRemotePaneStore.getState().consumeReattach("pane-a")).toBe("host-recovered");
  });

  it("creates it again when the host server comes up after the host read connected", async () => {
    act(() => useHostStore.setState({ hosts: [box("connected")] }));
    await act(async () => {});
    // The remount's create was refused: the host server was not up yet.
    useRemotePaneStore.getState().awaitHost("pane-a", "box");
    expect(useRemotePaneStore.getState().consumeReattach("pane-a")).toBeNull();

    await serverChanged("connected");
    const store = useRemotePaneStore.getState();
    expect(store.consumeReattach("pane-a")).toBe("host-recovered");
    expect(store.panes["pane-a"]?.awaiting).toBe(false);
  });

  it("leaves a waiting pane be while the host server is not connected", async () => {
    useRemotePaneStore.getState().awaitHost("pane-a", "box");
    await serverChanged("connecting");
    expect(useRemotePaneStore.getState().consumeReattach("pane-a")).toBeNull();
  });

  it("lets go of the host server's broadcast on unmount", () => {
    expect(serverListeners.size).toBe(1);
    act(() => root.unmount());
    expect(serverListeners.size).toBe(0);
    root = createRoot(document.createElement("div"));
  });
});
