import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePaneHostStore, selectTabRemoteHostId } from "../pane-host-store";
import type { PaneNode } from "../pane-tree";

const leaf = (paneId: string): PaneNode => ({ type: "leaf", paneId });
const split = (a: PaneNode, b: PaneNode): PaneNode => ({
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first: a,
  second: b,
});

describe("pane-host-store", () => {
  beforeEach(() => {
    usePaneHostStore.setState({ remoteHostByPane: {} });
  });

  it("never updates for local panes, so local-only users re-render nothing", () => {
    const listener = vi.fn();
    const unsubscribe = usePaneHostStore.subscribe(listener);
    const { setPaneHost, forgetPane } = usePaneHostStore.getState();

    setPaneHost("pane-a", "local");
    setPaneHost("pane-b", undefined); // older main / no host reported
    forgetPane("pane-a");

    expect(listener).not.toHaveBeenCalled();
    expect(selectTabRemoteHostId(split(leaf("pane-a"), leaf("pane-b")))(
      usePaneHostStore.getState(),
    )).toBeNull();
    unsubscribe();
  });

  it("badges a tab from the host its pane actually runs on", () => {
    usePaneHostStore.getState().setPaneHost("pane-remote", "box");
    const state = usePaneHostStore.getState();

    // The remote pane's own tab — even split with a local pane.
    expect(
      selectTabRemoteHostId(split(leaf("pane-local"), leaf("pane-remote")))(state),
    ).toBe("box");
    // A tab of local panes gets no badge, whatever its project's host now is.
    expect(selectTabRemoteHostId(leaf("pane-local"))(state)).toBeNull();
  });

  it("re-recording the same host is a no-op; a reset onto local clears it", () => {
    const { setPaneHost } = usePaneHostStore.getState();
    setPaneHost("pane-a", "box");
    const listener = vi.fn();
    const unsubscribe = usePaneHostStore.subscribe(listener);

    setPaneHost("pane-a", "box");
    expect(listener).not.toHaveBeenCalled();

    setPaneHost("pane-a", "local");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(usePaneHostStore.getState().remoteHostByPane).toEqual({});
    unsubscribe();
  });

  it("forgets a killed pane", () => {
    const { setPaneHost, forgetPane } = usePaneHostStore.getState();
    setPaneHost("pane-a", "box");
    forgetPane("pane-a");
    expect(selectTabRemoteHostId(leaf("pane-a"))(usePaneHostStore.getState())).toBeNull();
  });
});
