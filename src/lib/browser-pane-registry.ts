import type { BrowserPaneRef } from "../components/workspace-panes/BrowserPane/BrowserPane";

const registry = new Map<string, BrowserPaneRef>();

export function registerBrowserPane(paneId: string, ref: BrowserPaneRef) {
  registry.set(paneId, ref);
}

export function unregisterBrowserPane(paneId: string) {
  registry.delete(paneId);
}

export function getBrowserPaneRef(paneId: string): BrowserPaneRef | undefined {
  return registry.get(paneId);
}
