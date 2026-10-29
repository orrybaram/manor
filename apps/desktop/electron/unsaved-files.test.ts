import { beforeEach, describe, expect, it, vi } from "vitest";

const { ipcHandlers, showMessageBoxSync } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => void>(),
  showMessageBoxSync: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  dialog: { showMessageBoxSync },
  ipcMain: {
    on: (channel: string, handler: (...args: unknown[]) => void) =>
      ipcHandlers.set(channel, handler),
  },
}));

import {
  confirmCloseOverUnsaved,
  confirmQuitOverUnsaved,
  registerUnsavedFilesIpc,
  unsavedFilesPrompt,
} from "./unsaved-files";

registerUnsavedFilesIpc();

/** A window whose renderer reported `files`. */
function windowWith(id: number, files: string[]) {
  const sender = { id, once: vi.fn() };
  ipcHandlers.get("window:setUnsavedFiles")!({ sender }, files);
  return { webContents: { id } } as never;
}

beforeEach(() => showMessageBoxSync.mockReset());

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
  it("goes ahead without asking when no window has unsaved edits", () => {
    const win = windowWith(1, []);
    expect(confirmQuitOverUnsaved([win])).toBe(true);
    expect(confirmCloseOverUnsaved(win)).toBe(true);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("asks about every window's files on quit; Cancel stops it", () => {
    const a = windowWith(2, ["a.ts"]);
    const b = windowWith(3, ["b.ts", "c.ts"]);
    showMessageBoxSync.mockReturnValue(1);
    expect(confirmQuitOverUnsaved([a, b])).toBe(false);
    expect(showMessageBoxSync.mock.calls[0][1]).toMatchObject({
      message: "3 files have unsaved changes",
    });
    showMessageBoxSync.mockReturnValue(0);
    expect(confirmQuitOverUnsaved([a, b])).toBe(true);
  });

  it("asks about the closing window's files only, and forgets them once it goes", () => {
    const win = windowWith(4, ["a.ts"]);
    showMessageBoxSync.mockReturnValue(0);
    expect(confirmCloseOverUnsaved(win)).toBe(true);
    showMessageBoxSync.mockClear();
    expect(confirmQuitOverUnsaved([win])).toBe(true);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });
});
