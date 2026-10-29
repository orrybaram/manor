import { beforeEach, describe, expect, it, vi } from "vitest";

const { ipcOn, ipcHandle, showMessageBox } = vi.hoisted(() => ({
  ipcOn: new Map<string, (...args: unknown[]) => void>(),
  ipcHandle: new Map<string, (...args: unknown[]) => unknown>(),
  showMessageBox: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBox },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) => ipcOn.set(channel, handler),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      ipcHandle.set(channel, handler),
  },
}));

import {
  confirmCloseOverUnsaved,
  confirmQuitOverUnsaved,
  hasUnsavedFiles,
  holdCloseForUnsaved,
  holdQuitForUnsaved,
  registerUnsavedFilesIpc,
  unattendedQuitRefusal,
  unsavedFilesPrompt,
  unsavedPanesElsewhere,
} from "./unsaved-files";

registerUnsavedFilesIpc();

type Listener = (...args: unknown[]) => void;

/** A renderer's `webContents`, recording the listeners put on it. */
function contentsOf(id: number) {
  const listeners = new Map<string, Listener[]>();
  const add = (event: string, fn: Listener) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
  };
  return {
    id,
    once: vi.fn(add),
    on: vi.fn(add),
    listeners,
    emit: (event: string) => listeners.get(event)?.forEach((fn) => fn()),
  };
}

type Contents = ReturnType<typeof contentsOf>;
type Win = Parameters<typeof confirmCloseOverUnsaved>[0];

/** The renderer of `contents` reported `paths`, one pane each. */
function report(contents: Contents, paths: string[]) {
  ipcOn.get("window:setUnsavedFiles")!(
    { sender: contents },
    paths.map((path) => ({ paneId: `${contents.id}:${path}`, path })),
  );
}

/** A window whose renderer reported `paths`. */
function windowWith(id: number, paths: string[]): { win: Win; contents: Contents } {
  const contents = contentsOf(id);
  report(contents, paths);
  const win = {
    webContents: contents,
    isDestroyed: () => false,
    close: vi.fn(),
  } as unknown as Win;
  return { win, contents };
}

/** A message box the test answers with `answer`, when it likes. */
function pendingBox() {
  let answer!: (response: number) => void;
  showMessageBox.mockReturnValueOnce(
    new Promise((resolve) => {
      answer = (response) => resolve({ response, checkboxChecked: false });
    }),
  );
  return (response: number) => answer(response);
}

beforeEach(() => showMessageBox.mockReset());

describe("unsavedFilesPrompt", () => {
  it("counts and lists the files, with Quit Anyway / Cancel", () => {
    const prompt = unsavedFilesPrompt(["src/a.ts", "b.md"], "quit");
    expect(prompt.message).toBe("2 files have unsaved changes");
    expect(prompt.detail).toContain("src/a.ts\nb.md");
    expect(prompt.buttons).toEqual(["Quit Anyway", "Cancel"]);
    expect(prompt.cancelId).toBe(1);
    expect(unsavedFilesPrompt(["a"], "close")).toMatchObject({
      message: "1 file has unsaved changes",
      buttons: ["Close Anyway", "Cancel"],
    });
  });
});

describe("confirming a quit or a close", () => {
  it("goes ahead without asking when no window has unsaved edits", async () => {
    const { win } = windowWith(1, []);
    expect(hasUnsavedFiles([win])).toBe(false);
    expect(await confirmQuitOverUnsaved([win])).toBe(true);
    expect(await confirmCloseOverUnsaved(win)).toBe(true);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it("asks with the async box about every window's files on quit; Cancel stops it", async () => {
    const { win: a } = windowWith(2, ["a.ts"]);
    const { win: b } = windowWith(3, ["b.ts", "c.ts"]);
    expect(hasUnsavedFiles([a, b])).toBe(true);
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(await confirmQuitOverUnsaved([a, b])).toBe(false);
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      message: "3 files have unsaved changes",
    });
    // Cancel forgets nothing.
    expect(hasUnsavedFiles([a, b])).toBe(true);
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await confirmQuitOverUnsaved([a, b])).toBe(true);
    // Quit Anyway forgets them, so the quit it retries passes.
    expect(hasUnsavedFiles([a, b])).toBe(false);
  });

  it("asks about the closing window's files only, and forgets them once it goes", async () => {
    const { win } = windowWith(4, ["a.ts"]);
    const { win: other, contents: otherContents } = windowWith(5, ["b.ts"]);
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await confirmCloseOverUnsaved(win)).toBe(true);
    expect(showMessageBox.mock.calls[0][0]).toBe(win);
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      message: "1 file has unsaved changes",
    });
    expect(hasUnsavedFiles([win])).toBe(false);
    expect(hasUnsavedFiles([other])).toBe(true);
    report(otherContents, []);
  });

  it("ignores a second quit or close while the box is up, and asks again once it is answered", async () => {
    const { win } = windowWith(6, ["a.ts"]);
    const answer = pendingBox();
    const first = confirmQuitOverUnsaved([win]);
    // Re-entry: another ⌘Q, the window's close button, an install.
    expect(await confirmQuitOverUnsaved([win])).toBe(false);
    expect(await confirmCloseOverUnsaved(win)).toBe(false);
    expect(showMessageBox).toHaveBeenCalledOnce();
    answer(1);
    expect(await first).toBe(false);
    showMessageBox.mockResolvedValueOnce({ response: 0 });
    expect(await confirmCloseOverUnsaved(win)).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("a box that fails to show keeps the edits and goes nowhere", async () => {
    const { win, contents } = windowWith(7, ["a.ts"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    showMessageBox.mockRejectedValueOnce(new Error("no display"));
    expect(await confirmCloseOverUnsaved(win)).toBe(false);
    expect(hasUnsavedFiles([win])).toBe(true);
    error.mockRestore();
    report(contents, []);
  });
});

describe("holding a close or a quit to ask", () => {
  /** Let the box's answer reach its `.then`. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("lets a clean window close, and a clean quit go on, without holding", () => {
    const { win } = windowWith(20, []);
    const event = { preventDefault: vi.fn() };
    expect(holdCloseForUnsaved(win, event)).toBe(false);
    expect(holdQuitForUnsaved([win], vi.fn())).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("holds the close, and closes again on Close Anyway, which then passes", async () => {
    const { win } = windowWith(21, ["a.ts"]);
    const event = { preventDefault: vi.fn() };
    const answer = pendingBox();
    expect(holdCloseForUnsaved(win, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    // The window's close button again while the box is up: held, not asked twice.
    expect(holdCloseForUnsaved(win, { preventDefault: vi.fn() })).toBe(true);
    await settle();
    expect(win.close).not.toHaveBeenCalled();
    answer(0);
    await settle();
    expect(win.close).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(holdCloseForUnsaved(win, { preventDefault: vi.fn() })).toBe(false);
  });

  it("Cancel keeps the window open and its edits known", async () => {
    const { win, contents } = windowWith(22, ["a.ts"]);
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(holdCloseForUnsaved(win, { preventDefault: vi.fn() })).toBe(true);
    await settle();
    expect(win.close).not.toHaveBeenCalled();
    expect(hasUnsavedFiles([win])).toBe(true);
    report(contents, []);
  });

  it("holds the quit, and quits again on Quit Anyway, once", async () => {
    const { win } = windowWith(23, ["a.ts"]);
    const quit = vi.fn();
    const answer = pendingBox();
    expect(holdQuitForUnsaved([win], quit)).toBe(true);
    // A second ⌘Q while the box is up is ignored.
    expect(holdQuitForUnsaved([win], quit)).toBe(true);
    answer(0);
    await settle();
    expect(quit).toHaveBeenCalledOnce();
    expect(holdQuitForUnsaved([win], quit)).toBe(false);
  });

  it("a cancelled quit quits nothing", async () => {
    const { win, contents } = windowWith(24, ["a.ts"]);
    const quit = vi.fn();
    showMessageBox.mockResolvedValueOnce({ response: 1 });
    expect(holdQuitForUnsaved([win], quit)).toBe(true);
    await settle();
    expect(quit).not.toHaveBeenCalled();
    report(contents, []);
  });
});

describe("a quit nobody at the desk asked for", () => {
  it("is refused while any window has unsaved edits, naming how many", () => {
    expect(unattendedQuitRefusal()).toBeNull();
    const a = windowWith(8, ["a.ts"]);
    expect(unattendedQuitRefusal()).toBe(
      "1 file has unsaved changes on the desktop. Save or discard them there first.",
    );
    const b = windowWith(9, ["b.ts", "c.ts"]);
    expect(unattendedQuitRefusal()).toMatch(/^3 files have unsaved changes on the desktop/);
    report(a.contents, []);
    report(b.contents, []);
    expect(unattendedQuitRefusal()).toBeNull();
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});

describe("the registry", () => {
  it("answers which panes are dirty in another window than the asker's", async () => {
    const primary = windowWith(10, ["mine.ts"]);
    const detached = windowWith(11, ["theirs.ts"]);
    expect(unsavedPanesElsewhere(10, ["10:mine.ts", "11:theirs.ts", "pane-x"])).toEqual([
      { paneId: "11:theirs.ts", path: "theirs.ts" },
    ]);
    expect(unsavedPanesElsewhere(11, ["10:mine.ts", "11:theirs.ts"])).toEqual([
      { paneId: "10:mine.ts", path: "mine.ts" },
    ]);
    // Over IPC, the asker is the sender.
    const handler = ipcHandle.get("window:unsavedPanesElsewhere")!;
    expect(await handler({ sender: { id: 10 } }, ["11:theirs.ts", 5])).toEqual([
      { paneId: "11:theirs.ts", path: "theirs.ts" },
    ]);
    expect(await handler({ sender: { id: 10 } }, "nope")).toEqual([]);
    report(primary.contents, []);
    report(detached.contents, []);
  });

  it("ignores a report that is not pane/path pairs", () => {
    const contents = contentsOf(12);
    ipcOn.get("window:setUnsavedFiles")!({ sender: contents }, ["a.ts"]);
    expect(unattendedQuitRefusal()).toBeNull();
  });

  it("watches each renderer once, however often it goes dirty", () => {
    const contents = contentsOf(13);
    report(contents, ["a.ts"]);
    report(contents, []);
    report(contents, ["a.ts"]);
    report(contents, []);
    report(contents, ["b.ts"]);
    expect(contents.once).toHaveBeenCalledTimes(1);
    expect(contents.on).toHaveBeenCalledTimes(1);
    expect(contents.listeners.get("destroyed")).toHaveLength(1);
    expect(contents.listeners.get("render-process-gone")).toHaveLength(1);
    contents.emit("destroyed");
    expect(unattendedQuitRefusal()).toBeNull();
  });

  it("forgets a crashed renderer's files: its edits are gone with it", () => {
    const contents = contentsOf(14);
    report(contents, ["a.ts"]);
    expect(unattendedQuitRefusal()).not.toBeNull();
    contents.emit("render-process-gone");
    expect(unattendedQuitRefusal()).toBeNull();
    // A reloaded renderer reports again, and is not watched twice.
    report(contents, ["a.ts"]);
    expect(unattendedQuitRefusal()).not.toBeNull();
    expect(contents.on).toHaveBeenCalledTimes(1);
    report(contents, []);
  });
});
