import { describe, expect, it } from "vitest";
import {
  diskChangeAction,
  initialOpenFile,
  openFileReducer,
  resumeOpenFile,
  type OpenFileEvent,
  type OpenFileState,
} from "./open-file-state";

function run(state: OpenFileState, ...events: OpenFileEvent[]): OpenFileState {
  return events.reduce(openFileReducer, state);
}

const opened = run(initialOpenFile("src/a.ts"), {
  type: "read",
  content: "one",
  hash: "h1",
  reason: "open",
});
const dirty = run(opened, { type: "edited", dirty: true });

describe("openFileReducer", () => {
  it("opens clean on the first read, expecting its hash", () => {
    expect(opened).toMatchObject({
      status: "ready",
      base: "one",
      expectedHash: "h1",
      dirty: false,
      baseVersion: 1,
    });
  });

  it("reloads a clean file that changed on disk", () => {
    const next = run(opened, { type: "read", content: "two", hash: "h2", reason: "changed" });
    expect(next).toMatchObject({ base: "two", expectedHash: "h2", baseVersion: 2, dirty: false });
  });

  it("keeps your edits, and the hash they started from, when a dirty file changes on disk", () => {
    const next = run(dirty, { type: "read", content: "theirs", hash: "h2", reason: "changed" });
    expect(next).toMatchObject({ dirty: true, base: "one", expectedHash: "h1", baseVersion: 1 });
  });

  it("keeps your edits over a file that can no longer be read; a clean one shows why", () => {
    expect(run(dirty, { type: "read-failed", message: "Binary" })).toBe(dirty);
    expect(run(opened, { type: "read-failed", message: "Binary" })).toMatchObject({
      status: "failed",
      message: "Binary",
    });
  });

  it("goes dirty on an edit and clean again when the edit is undone", () => {
    expect(dirty.dirty).toBe(true);
    expect(run(dirty, { type: "edited", dirty: false }).dirty).toBe(false);
  });

  it("does not reload when a change reads back as the file it already has", () => {
    const next = run(opened, { type: "read", content: "one", hash: "h1", reason: "changed" });
    expect(next).toBe(opened);
  });

  it("a save stores the written hash and clears dirty", () => {
    const next = run(
      dirty,
      { type: "save-started" },
      { type: "saved", content: "mine", hash: "h3", dirty: false },
    );
    expect(next).toMatchObject({
      saving: false,
      dirty: false,
      base: "mine",
      expectedHash: "h3",
      baseVersion: 1,
    });
  });

  it("stays dirty after a save when you typed more while it was in flight", () => {
    const next = run(dirty, { type: "save-started" }, { type: "saved", content: "m", hash: "h3", dirty: true });
    expect(next.dirty).toBe(true);
    expect(next.expectedHash).toBe("h3");
  });

  it("shows other save failures inline and keeps the edits", () => {
    const next = run(dirty, { type: "save-started" }, { type: "save-failed", message: "Disk full" });
    expect(next).toMatchObject({ saving: false, saveError: "Disk full", dirty: true });
  });

  it("asks before opening another file only while dirty", () => {
    expect(run(opened, { type: "ask-before-open", path: "b" }).pendingOpen).toBeNull();
    const asking = run(dirty, { type: "ask-before-open", path: "b" });
    expect(asking.pendingOpen).toBe("b");
    expect(run(asking, { type: "cancel-open" })).toMatchObject({ pendingOpen: null, dirty: true });
    expect(run(asking, { type: "discard" })).toMatchObject({ pendingOpen: null, dirty: false });
  });
});

describe("diskChangeAction", () => {
  it("ignores the hash it already expects: the file it read, or its own save's echo", () => {
    expect(diskChangeAction(opened, "h1")).toBe("ignore");
    const saved = run(dirty, { type: "save-started" }, { type: "saved", content: "m", hash: "h3", dirty: false });
    expect(diskChangeAction(saved, "h3")).toBe("ignore");
  });

  it("waits for a save in flight before judging a change", () => {
    expect(diskChangeAction(run(dirty, { type: "save-started" }), "h3")).toBe("after-save");
  });

  it("reads a new hash, or a file that went away (to say why)", () => {
    expect(diskChangeAction(dirty, "h2")).toBe("read");
    expect(diskChangeAction(opened, null)).toBe("read");
  });

});

describe("resumeOpenFile", () => {
  it("keeps unsaved edits to the same file across a remount", () => {
    const stashed = run(dirty, { type: "stash-draft", draft: "one!" });
    const resumed = resumeOpenFile(stashed, "src/a.ts");
    expect(resumed).toMatchObject({ dirty: true, draft: "one!", expectedHash: "h1" });
  });

  it("starts fresh for another file or a clean one", () => {
    expect(resumeOpenFile(opened, "src/a.ts")).toEqual(initialOpenFile("src/a.ts"));
    const stashed = run(dirty, { type: "stash-draft", draft: "x" });
    expect(resumeOpenFile(stashed, "src/b.ts").status).toBe("loading");
  });

});
