import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  awaitPaneHost,
  isAwaitingHost,
  selectTabRemoteHostId,
  takePanesAwaitingHost,
  usePaneHostStore,
} from "../pane-host-store";
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

describe("panes awaiting their host (ADR-178 §6)", () => {
  beforeEach(() => {
    usePaneHostStore.setState({ remoteHostByPane: {} });
    takePanesAwaitingHost("box");
    takePanesAwaitingHost("other");
  });

  it("records the awaited host, so the pane banners as that host's", () => {
    awaitPaneHost("p", "box");
    expect(isAwaitingHost("p")).toBe(true);
    expect(usePaneHostStore.getState().remoteHostByPane).toEqual({ p: "box" });
  });

  it("hands over the panes waiting for a host, once", () => {
    awaitPaneHost("a", "box");
    awaitPaneHost("b", "box");
    awaitPaneHost("c", "other");
    expect(takePanesAwaitingHost("box", (id) => id !== "b")).toEqual(["a"]);
    expect(takePanesAwaitingHost("box")).toEqual(["b"]);
    expect(takePanesAwaitingHost("box")).toEqual([]);
    expect(isAwaitingHost("c")).toBe(true);
  });

  it("stops waiting once the pane has a session, or is forgotten", () => {
    awaitPaneHost("a", "box");
    awaitPaneHost("b", "box");
    usePaneHostStore.getState().setPaneHost("a", "box");
    usePaneHostStore.getState().forgetPane("b");
    expect(isAwaitingHost("a")).toBe(false);
    expect(isAwaitingHost("b")).toBe(false);
  });
});
