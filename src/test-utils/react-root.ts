/**
 * Scaffolding for tests that mount React components into a detached DOM node
 * and drive them through the stores. Needs a DOM test environment: use
 * `happy-dom`. The jsdom this repo pins needs Node 22.22+, and CI and local
 * shells run Node 20, where a jsdom test file fails before any test starts.
 */
import { act, createElement, Profiler, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { useAppStore } from "../store/app-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type TestRoot = {
  /** The node the root renders into. */
  container: HTMLDivElement;
  render: (element: ReactElement) => void;
  unmount: () => void;
};

/** A React root on a detached node; `render` and `unmount` run inside `act`. */
export function createTestRoot(): TestRoot {
  const container = document.createElement("div");
  const root = createRoot(container);
  return {
    container,
    render: (element) => act(() => root.render(element)),
    unmount: () => act(() => root.unmount()),
  };
}

/**
 * Renders `element` into `root`, counting the commits in which anything in
 * its tree rendered. The first render counts as one.
 */
export function renderCounted(
  root: TestRoot,
  element: ReactElement,
): { readonly commits: number } {
  const counter = { commits: 0 };
  root.render(
    createElement(
      Profiler,
      { id: "counted", onRender: () => counter.commits++ },
      element,
    ),
  );
  return counter;
}

/** Sets a pane's live terminal title, as the terminal would, inside `act`. */
export function setPaneTitle(paneId: string, title: string): void {
  act(() => useAppStore.getState().setPaneTitle(paneId, title));
}
