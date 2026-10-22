import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { useToastStore } from "../../store/toast-store";
import { dropFilesOnTerminal, isFileDrag, shellQuote } from "../terminal-file-drop";

const isRemotePane = vi.hoisted(() => vi.fn<(paneId: string) => boolean>());
const pasteImageFile = vi.hoisted(() =>
  vi.fn<(term: Terminal, paneId: string, blob: Blob) => Promise<void>>(),
);
vi.mock("../remote-image-paste", () => ({ isRemotePane, pasteImageFile }));

const isWebApp = vi.hoisted(() => vi.fn<() => boolean>());
vi.mock("../platform", () => ({ isWebApp }));

const paths = new Map<File, string>();
(window as unknown as Record<string, unknown>).manorHost = {
  pathForFile: (file: File) => paths.get(file) ?? "",
};

const PANE_ID = "pane-1";

function makeTerm(): Terminal {
  return { paste: vi.fn() } as unknown as Terminal;
}

function file(name: string, type: string, path?: string): File {
  const f = new File(["x"], name, { type });
  if (path) paths.set(f, path);
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  paths.clear();
  isRemotePane.mockReturnValue(false);
  isWebApp.mockReturnValue(false);
  useToastStore.setState({ toasts: [] });
});

describe("shellQuote", () => {
  it("leaves a plain path alone and quotes the rest", () => {
    expect(shellQuote("/tmp/shot.png")).toBe("/tmp/shot.png");
    expect(shellQuote("/Users/me/Screenshot 2026-10-22 at 9.41.03 AM.png")).toBe(
      "'/Users/me/Screenshot 2026-10-22 at 9.41.03 AM.png'",
    );
    expect(shellQuote("/tmp/it's.png")).toBe(`'/tmp/it'"'"'s.png'`);
  });
});

describe("isFileDrag", () => {
  it("is true only for a drag carrying files", () => {
    expect(isFileDrag({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(
      isFileDrag({ types: ["application/x-manor-pane"] } as unknown as DataTransfer),
    ).toBe(false);
    expect(isFileDrag(null)).toBe(false);
  });
});

describe("dropFilesOnTerminal", () => {
  it("pastes a local pane's dropped files as quoted paths", async () => {
    const term = makeTerm();
    await dropFilesOnTerminal(term, PANE_ID, [
      file("Screenshot 1.png", "image/png", "/Users/me/Screenshot 1.png"),
      file("notes.txt", "text/plain", "/Users/me/notes.txt"),
    ]);
    expect(term.paste).toHaveBeenNthCalledWith(1, "'/Users/me/Screenshot 1.png' ");
    expect(term.paste).toHaveBeenNthCalledWith(2, "/Users/me/notes.txt ");
    expect(pasteImageFile).not.toHaveBeenCalled();
  });

  it("uploads an image to a remote pane's host instead of pasting a local path", async () => {
    isRemotePane.mockReturnValue(true);
    const term = makeTerm();
    const shot = file("shot.png", "image/png", "/Users/me/shot.png");
    await dropFilesOnTerminal(term, PANE_ID, [shot]);
    expect(pasteImageFile).toHaveBeenCalledWith(term, PANE_ID, shot);
    expect(term.paste).not.toHaveBeenCalled();
  });

  it("uploads on the web, where no file has a path", async () => {
    isWebApp.mockReturnValue(true);
    const term = makeTerm();
    const shot = file("shot.png", "image/png");
    await dropFilesOnTerminal(term, PANE_ID, [shot]);
    expect(pasteImageFile).toHaveBeenCalledWith(term, PANE_ID, shot);
  });

  it("uploads a local pane's image that has no path on disk", async () => {
    const term = makeTerm();
    const dragged = file("image.png", "image/png");
    await dropFilesOnTerminal(term, PANE_ID, [dragged]);
    expect(pasteImageFile).toHaveBeenCalledWith(term, PANE_ID, dragged);
  });

  it("skips a non-image a remote host can't read, and says so", async () => {
    isRemotePane.mockReturnValue(true);
    const term = makeTerm();
    await dropFilesOnTerminal(term, PANE_ID, [
      file("notes.txt", "text/plain", "/Users/me/notes.txt"),
    ]);
    expect(term.paste).not.toHaveBeenCalled();
    expect(pasteImageFile).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ status: "error" }),
    ]);
  });
});
