/**
 * Scaffolding for tests that mount React components into a detached DOM node
 * and drive them through the stores. Needs a DOM test environment.
 */
import { act, type ReactElement } from "react";
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

/** Sets a pane's live terminal title, as the terminal would, inside `act`. */
export function setPaneTitle(paneId: string, title: string): void {
  act(() => useAppStore.getState().setPaneTitle(paneId, title));
}
