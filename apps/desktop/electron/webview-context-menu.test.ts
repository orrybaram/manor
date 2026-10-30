import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  buildPageContextMenu,
  type PageMenuActions,
  type PageMenuParams,
} from "./webview-context-menu";

function params(overrides: Partial<PageMenuParams> = {}): PageMenuParams {
  return {
    x: 10,
    y: 20,
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    isEditable: false,
    selectionText: "",
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
    ...overrides,
  };
}

function actions(overrides: Partial<PageMenuActions> = {}): PageMenuActions {
  return {
    canGoBack: true,
    canGoForward: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    openInNewTab: vi.fn(),
    openInSplit: vi.fn(),
    copyText: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    saveImageAs: vi.fn(),
    copyImageAt: vi.fn(),
    inspectElement: vi.fn(),
    ...overrides,
  };
}

/** The menu as labels, with "—" for a separator. */
function labels(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) => (item.type === "separator" ? "—" : String(item.label)));
}

function item(template: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = template.find((i) => i.label === label);
  if (!found) throw new Error(`no "${label}" item`);
  return found;
}

function click(template: MenuItemConstructorOptions[], label: string): void {
  (item(template, label).click as () => void)();
}

describe("buildPageContextMenu", () => {
  it("on a plain page: navigation, then Inspect Element", () => {
    const template = buildPageContextMenu(params(), actions());
    expect(labels(template)).toEqual(["Back", "Forward", "Reload", "—", "Inspect Element"]);
  });

  it("disables Back and Forward when there is nowhere to go", () => {
    const template = buildPageContextMenu(params(), actions({ canGoBack: false, canGoForward: true }));
    expect(item(template, "Back").enabled).toBe(false);
    expect(item(template, "Forward").enabled).toBe(true);
    click(template, "Forward");
  });

  it("on an editable image link: every group, in order", () => {
    const template = buildPageContextMenu(
      params({
        linkURL: "https://example.com/a",
        srcURL: "https://example.com/a.png",
        mediaType: "image",
        isEditable: true,
      }),
      actions(),
    );
    expect(labels(template)).toEqual([
      "Back",
      "Forward",
      "Reload",
      "—",
      "Open Link in New Tab",
      "Open Link in Split",
      "Copy Link Address",
      "—",
      "Cut",
      "Copy",
      "Paste",
      "Select All",
      "—",
      "Open Image in New Tab",
      "Save Image As...",
      "Copy Image",
      "Copy Image Address",
      "—",
      "Inspect Element",
    ]);
  });

  it("shows the editing items for a selection, enabled by the page's edit flags", () => {
    const template = buildPageContextMenu(
      params({
        selectionText: "hello",
        editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
      }),
      actions(),
    );
    expect(item(template, "Cut").enabled).toBe(false);
    expect(item(template, "Copy").enabled).toBe(true);
    expect(item(template, "Paste").enabled).toBe(false);
    expect(item(template, "Select All").enabled).toBe(true);
  });

  it("runs each item's action with the link, image or point it was opened on", () => {
    const a = actions();
    const template = buildPageContextMenu(
      params({ linkURL: "https://example.com/a", srcURL: "https://example.com/a.png", mediaType: "image", isEditable: true }),
      a,
    );
    click(template, "Back");
    click(template, "Reload");
    click(template, "Open Link in New Tab");
    click(template, "Open Link in Split");
    click(template, "Copy Link Address");
    click(template, "Paste");
    click(template, "Copy Image Address");
    click(template, "Copy Image");
    click(template, "Inspect Element");
    expect(a.goBack).toHaveBeenCalled();
    expect(a.reload).toHaveBeenCalled();
    expect(a.openInNewTab).toHaveBeenCalledWith("https://example.com/a");
    expect(a.openInSplit).toHaveBeenCalledWith("https://example.com/a");
    expect(a.copyText).toHaveBeenNthCalledWith(1, "https://example.com/a");
    expect(a.paste).toHaveBeenCalled();
    expect(a.copyText).toHaveBeenNthCalledWith(2, "https://example.com/a.png");
    expect(a.copyImageAt).toHaveBeenCalledWith(10, 20);
    expect(a.inspectElement).toHaveBeenCalledWith(10, 20);
  });
});
