import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  paneRemoteHost,
  remoteHostByPane,
  selectTabRemoteHostId,
  useRemotePaneStore,
} from "../remote-pane-store";
import type { PaneNode } from "../../lib/layout/pane-tree";

const leaf = (paneId: string): PaneNode => ({ type: "leaf", paneId });
const split = (a: PaneNode, b: PaneNode): PaneNode => ({
  type: "split",
  direction: "horizontal",
  ratio: 0.5,
  first: a,
  second: b,
});

const store = () => useRemotePaneStore.getState();
const isAwaitingHost = (paneId: string) => !!store().panes[paneId]?.awaiting;

beforeEach(() => {
  useRemotePaneStore.setState({ panes: {} });
});

describe("pane hosts (ADR-160)", () => {
  it("never updates for local panes, so local-only users re-render nothing", () => {
    const listener = vi.fn();
    const unsubscribe = useRemotePaneStore.subscribe(listener);
    const { setPaneHost, forgetPane, consumeReattach } = store();

    setPaneHost("pane-a", "local");
    setPaneHost("pane-b", undefined); // older main / no host reported
    forgetPane("pane-a");
    consumeReattach("pane-a");

    expect(listener).not.toHaveBeenCalled();
    expect(selectTabRemoteHostId(split(leaf("pane-a"), leaf("pane-b")))(store())).toBeNull();
    unsubscribe();
  });

  it("badges a tab from the host its pane actually runs on", () => {
    store().setPaneHost("pane-remote", "box");
    const state = store();

    // The remote pane's own tab — even split with a local pane.
    expect(
      selectTabRemoteHostId(split(leaf("pane-local"), leaf("pane-remote")))(state),
    ).toBe("box");
    // A tab of local panes gets no badge, whatever its project's host now is.
    expect(selectTabRemoteHostId(leaf("pane-local"))(state)).toBeNull();
    expect(paneRemoteHost(state, "pane-remote")).toBe("box");
    expect(paneRemoteHost(state, "pane-local")).toBeUndefined();
  });

  it("re-recording the same host is a no-op; a reset onto local clears it", () => {
    const { setPaneHost } = store();
    setPaneHost("pane-a", "box");
    const listener = vi.fn();
    const unsubscribe = useRemotePaneStore.subscribe(listener);

    setPaneHost("pane-a", "box");
    expect(listener).not.toHaveBeenCalled();

    setPaneHost("pane-a", "local");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(remoteHostByPane(store())).toEqual({});
    unsubscribe();
  });

  it("forgets a killed pane", () => {
    store().setPaneHost("pane-a", "box");
    store().forgetPane("pane-a");
    expect(selectTabRemoteHostId(leaf("pane-a"))(store())).toBeNull();
  });
});

describe("panes awaiting their host (ADR-178 §6)", () => {
  it("records the awaited host, so the pane banners as that host's", () => {
    store().awaitHost("p", "box");
    expect(isAwaitingHost("p")).toBe(true);
    expect(remoteHostByPane(store())).toEqual({ p: "box" });
  });

  it("hands over the panes waiting for a host, once", () => {
    store().awaitHost("a", "box");
    store().awaitHost("b", "box");
    store().awaitHost("c", "other");
    expect(store().takePanesAwaitingHost("box", (id) => id !== "b")).toEqual(["a"]);
    expect(store().takePanesAwaitingHost("box")).toEqual(["b"]);
    expect(store().takePanesAwaitingHost("box")).toEqual([]);
    expect(isAwaitingHost("c")).toBe(true);
    // Taken panes still banner as their host's until they have a session.
    expect(paneRemoteHost(store(), "a")).toBe("box");
  });

  it("stops waiting once the pane has a session, or is forgotten", () => {
    store().awaitHost("a", "box");
    store().awaitHost("b", "box");
    store().setPaneHost("a", "box");
    store().forgetPane("b");
    expect(isAwaitingHost("a")).toBe(false);
    expect(isAwaitingHost("b")).toBe(false);
  });
});

describe("reattach (ADR-178 §6)", () => {
  it("bumps each pane's epoch so its terminal remounts", () => {
    store().reattach(["a", "b"]);
    store().reattach(["a"]);
    expect(store().panes.a.reattachEpoch).toBe(2);
    expect(store().panes.b.reattachEpoch).toBe(1);
  });

  it("does not update for an empty list", () => {
    const before = store();
    store().reattach([]);
    expect(store()).toBe(before);
  });

  it("marks the next mount as a reattach, once", () => {
    expect(store().consumeReattach("a")).toBe(false);
    store().reattach(["a"]);
    expect(store().consumeReattach("a")).toBe(true);
    expect(store().consumeReattach("a")).toBe(false);
  });

  it("keeps the epoch when the pane's host changes", () => {
    store().setPaneHost("a", "box");
    store().reattach(["a"]);
    store().setPaneHost("a", "local");
    expect(store().panes.a).toMatchObject({ hostId: null, reattachEpoch: 1 });
  });
});

describe("forgetPane (ADR-183)", () => {
  it("forgets the pane's reattach state along with its host", () => {
    store().awaitHost("a", "box");
    store().reattach(["a"]);
    store().forgetPane("a");
    expect(store().panes).toEqual({});
    expect(store().consumeReattach("a")).toBe(false);
  });
});
