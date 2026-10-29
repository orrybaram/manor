import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  noteDiskChangeDuringSave,
  registerOpenFileEditor,
  saveOpenFile,
  useOpenFileStore,
} from "../open-file-store";
import {
  answerUnsavedGuard,
  confirmUnsavedEdits,
  guardUnsavedEdits,
  useUnsavedGuardStore,
} from "../unsaved-guard-store";

const WS = { hostId: "local", path: "/repo" };

let write: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useOpenFileStore.setState({ byPane: {} });
  useUnsavedGuardStore.setState({ request: null, saving: false });
  write = vi.fn();
  const base = (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI;
  vi.stubGlobal("window", { ...window, electronAPI: { ...base, files: { write } } });
});

/** `paneId` has `path` open, edited to `draft` and stashed (its editor unmounted). */
function editAndUnmount(paneId: string, path: string, draft: string) {
  const files = useOpenFileStore.getState();
  files.open(paneId, WS, path);
  files.dispatch(paneId, { type: "read", content: "disk", hash: "h1", reason: "open" });
  files.dispatch(paneId, { type: "edited", dirty: true });
  files.dispatch(paneId, { type: "stash-draft", draft });
}

const file = (paneId: string) => useOpenFileStore.getState().byPane[paneId];

describe("guardUnsavedEdits", () => {
  it("goes ahead at once, synchronously, when nothing is dirty", () => {
    const proceed = vi.fn();
    guardUnsavedEdits(["pane-1"], "move", proceed);
    expect(proceed).toHaveBeenCalledOnce();
    expect(useUnsavedGuardStore.getState().request).toBeNull();
  });

  it("Save writes every dirty file, then goes ahead", async () => {
    editAndUnmount("pane-1", "a.ts", "mine a");
    editAndUnmount("pane-2", "b.ts", "mine b");
    write.mockResolvedValue({ ok: true, hash: "h2" });
    const proceed = vi.fn();

    guardUnsavedEdits(["pane-1", "pane-2", "pane-3"], "move", proceed);
    expect(proceed).not.toHaveBeenCalled();
    expect(useUnsavedGuardStore.getState().request?.paneIds).toEqual(["pane-1", "pane-2"]);

    await answerUnsavedGuard("save");
    await Promise.resolve();
    expect(write).toHaveBeenCalledWith(WS, "a.ts", "mine a", "h1");
    expect(write).toHaveBeenCalledWith(WS, "b.ts", "mine b", "h1");
    expect(file("pane-1")).toMatchObject({ dirty: false, expectedHash: "h2", base: "mine a" });
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("a save that finds the file changed on disk goes nowhere and raises the banner", async () => {
    editAndUnmount("pane-1", "a.ts", "mine");
    write.mockResolvedValue({ ok: false, reason: "changed-on-disk", message: "x", diskHash: "h9" });

    const go = confirmUnsavedEdits(["pane-1"], "convert");
    await answerUnsavedGuard("save");
    expect(await go).toBe(false);
    expect(file("pane-1")).toMatchObject({
      dirty: true,
      conflict: { kind: "changed", diskHash: "h9" },
    });
  });

  it("Discard drops the edits and goes ahead; Cancel keeps them and does not", async () => {
    editAndUnmount("pane-1", "a.ts", "mine");
    const cancelled = confirmUnsavedEdits(["pane-1"], "close");
    await answerUnsavedGuard("cancel");
    expect(await cancelled).toBe(false);
    expect(file("pane-1").dirty).toBe(true);

    const discarded = confirmUnsavedEdits(["pane-1"], "close");
    await answerUnsavedGuard("discard");
    expect(await discarded).toBe(true);
    expect(file("pane-1")).toMatchObject({ dirty: false, draft: null });
    expect(write).not.toHaveBeenCalled();
  });

  it("a newer question cancels one still open", async () => {
    editAndUnmount("pane-1", "a.ts", "mine");
    const first = confirmUnsavedEdits(["pane-1"], "move");
    const second = confirmUnsavedEdits(["pane-1"], "close");
    expect(await first).toBe(false);
    expect(useUnsavedGuardStore.getState().request?.verb).toBe("close");
    await answerUnsavedGuard("discard");
    expect(await second).toBe(true);
  });
});

describe("saveOpenFile", () => {
  it("lands its answer in the store after a remount, so the next save expects the new hash", async () => {
    const files = useOpenFileStore.getState();
    files.open("pane-1", WS, "a.ts");
    files.dispatch("pane-1", { type: "read", content: "disk", hash: "h1", reason: "open" });
    files.dispatch("pane-1", { type: "edited", dirty: true });
    const editor = (text: string) => ({
      workspace: WS,
      path: "a.ts",
      content: () => text,
      markClean: vi.fn((written: string) => written !== text),
      diskChanged: vi.fn(),
    });
    const first = editor("mine");
    const unregister = registerOpenFileEditor("pane-1", first);

    let answer!: (result: unknown) => void;
    write.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const saving = saveOpenFile("pane-1");
    expect(file("pane-1").saving).toBe(true);

    // A split rebuilds the pane mid-save: the first editor goes, a second comes.
    unregister();
    files.dispatch("pane-1", { type: "stash-draft", draft: "mine" });
    expect(useOpenFileStore.getState().open("pane-1", WS, "a.ts").dirty).toBe(true);
    const second = editor("mine");
    registerOpenFileEditor("pane-1", second);

    answer({ ok: true, hash: "h2" });
    expect(await saving).toBe(true);
    expect(file("pane-1")).toMatchObject({ dirty: false, expectedHash: "h2", saving: false });
    expect(second.markClean).toHaveBeenCalledWith("mine");
    expect(first.markClean).not.toHaveBeenCalled();
  });

  it("judges a change reported mid-save once the save answers", async () => {
    editAndUnmount("pane-1", "a.ts", "mine");
    const diskChanged = vi.fn();
    registerOpenFileEditor("pane-1", {
      workspace: WS,
      path: "a.ts",
      content: () => "mine",
      markClean: () => false,
      diskChanged,
    });
    write.mockResolvedValue({ ok: true, hash: "h2" });
    const saving = saveOpenFile("pane-1");
    noteDiskChangeDuringSave("pane-1", "h3");
    await saving;
    expect(diskChanged).toHaveBeenCalledWith("h3");
  });
});
