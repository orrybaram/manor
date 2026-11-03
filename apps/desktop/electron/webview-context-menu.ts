/**
 * The right-click menu of a browser pane's page, as a template: pure, so
 * which items show, in what order, and what each runs is testable without
 * Electron. `electron/ipc/webview.ts` supplies the actions and pops it up.
 */
import type { MenuItemConstructorOptions } from "electron";

/** The parts of Electron's `ContextMenuParams` the menu reads. */
export interface PageMenuParams {
  x: number;
  y: number;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

export interface PageMenuActions {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  /** A Manor browser tab, as `target=_blank` opens. */
  openInNewTab(url: string): void;
  /** A browser pane split beside this one. */
  openInSplit(url: string): void;
  copyText(text: string): void;
  cut(): void;
  copy(): void;
  paste(): void;
  selectAll(): void;
  saveImageAs(url: string): void;
  copyImageAt(x: number, y: number): void;
  inspectElement(x: number, y: number): void;
}

/**
 * Navigation; then the link's items, the editing items and the image's, each
 * only when the click was on one; then Inspect Element. Groups are divided
 * by separators.
 */
export function buildPageContextMenu(
  params: PageMenuParams,
  actions: PageMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];

  groups.push([
    { label: "Back", enabled: actions.canGoBack, click: () => actions.goBack() },
    { label: "Forward", enabled: actions.canGoForward, click: () => actions.goForward() },
    { label: "Reload", click: () => actions.reload() },
  ]);

  const link = params.linkURL;
  if (link) {
    groups.push([
      { label: "Open Link in New Tab", click: () => actions.openInNewTab(link) },
      { label: "Open Link in Split", click: () => actions.openInSplit(link) },
      { label: "Copy Link Address", click: () => actions.copyText(link) },
    ]);
  }

  if (params.isEditable || params.selectionText) {
    const { editFlags } = params;
    groups.push([
      { label: "Cut", enabled: editFlags.canCut, click: () => actions.cut() },
      { label: "Copy", enabled: editFlags.canCopy, click: () => actions.copy() },
      { label: "Paste", enabled: editFlags.canPaste, click: () => actions.paste() },
      { label: "Select All", enabled: editFlags.canSelectAll, click: () => actions.selectAll() },
    ]);
  }

  const image = params.srcURL;
  if (params.mediaType === "image" && image) {
    groups.push([
      { label: "Open Image in New Tab", click: () => actions.openInNewTab(image) },
      { label: "Save Image As...", click: () => actions.saveImageAs(image) },
      { label: "Copy Image", click: () => actions.copyImageAt(params.x, params.y) },
      { label: "Copy Image Address", click: () => actions.copyText(image) },
    ]);
  }

  groups.push([
    { label: "Inspect Element", click: () => actions.inspectElement(params.x, params.y) },
  ]);

  return groups.flatMap((group, i) =>
    i === 0 ? group : [{ type: "separator" as const }, ...group],
  );
}
