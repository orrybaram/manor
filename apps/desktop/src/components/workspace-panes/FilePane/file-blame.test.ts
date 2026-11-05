// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlameResult } from "../../../electron.d";
import { createBlameFollower, useBlamePref, type PaneBlame } from "./file-blame";

const ok = (sha: string): BlameResult => ({
  ok: true,
  commits: [{ sha, author: "a", time: 1, summary: "s", message: "m" }],
  lines: [0],
});

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup() {
  const status: PaneBlame[] = [];
  const revision = vi.fn(async (): Promise<string | null> => "head1");
  const blame = vi.fn(async (): Promise<BlameResult> => ok("a"));
  const text = vi.fn(async (): Promise<string | null> => "one\n");
  const follower = createBlameFollower({ revision, blame, text }, (s) => status.push(s));
  const shown: (string | null)[] = [];
  follower.follow((b) => shown.push(b ? b.commits[0].sha : null));
  return { follower, revision, blame, text, status, shown };
}

describe("createBlameFollower", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("while off, only asks whether the file can be blamed", async () => {
    t.follower.start(false);
    await flush();
    expect(t.status[t.status.length - 1]).toEqual({ available: true, note: null });
    expect(t.blame).not.toHaveBeenCalled();
  });

  it("says unavailable, and never blames, for a file git hasn't got", async () => {
    t.revision.mockResolvedValue(null);
    t.follower.start(true);
    await flush();
    expect(t.status[t.status.length - 1]).toEqual({ available: false, note: null });
    expect(t.blame).not.toHaveBeenCalled();
  });

  it("treats a failed check as unavailable", async () => {
    t.revision.mockRejectedValue(new Error("host away"));
    t.follower.start(true);
    await flush();
    expect(t.status[t.status.length - 1]).toEqual({ available: false, note: null });
  });

  it("shows the blame when on, and clears it when turned off", async () => {
    t.follower.start(true);
    await flush();
    expect(t.shown).toEqual(["a"]);
    t.follower.setOn(false);
    await flush();
    expect(t.shown).toEqual(["a", null]);
    expect(t.blame).toHaveBeenCalledTimes(1);
  });

  it("drops a blame that lands after blame was turned off", async () => {
    let answer!: (r: BlameResult) => void;
    t.blame.mockReturnValue(new Promise((r) => (answer = r)));
    t.follower.start(true);
    await flush();
    t.follower.setOn(false);
    answer(ok("late"));
    await flush();
    expect(t.shown).toEqual([]);
  });

  it("clears the column at once when turned off, whatever git is doing", async () => {
    t.follower.start(true);
    await flush();
    t.blame.mockReturnValue(new Promise(() => {}));
    t.follower.fileChanged();
    await flush();
    t.follower.setOn(false);
    expect(t.shown).toEqual(["a", null]);
    expect(t.status[t.status.length - 1]).toEqual({ available: true, note: null });
  });

  it("gives each blame the text git read", async () => {
    const heard: unknown[] = [];
    t.follower.follow((b) => heard.push(b?.text));
    t.text.mockResolvedValue("on disk\n");
    t.follower.start(true);
    await flush();
    expect(heard).toEqual(["on disk\n"]);
  });

  it("shows nothing, with a note, when the file can't be read for its blame", async () => {
    t.text.mockResolvedValue(null);
    t.follower.start(true);
    await flush();
    expect(t.shown).toEqual([]);
    expect(t.status[t.status.length - 1].note).toContain("Couldn't read");
  });

  it("hands a new listener the blame already there", async () => {
    t.follower.start(true);
    await flush();
    const heard: unknown[] = [];
    t.follower.follow((b) => heard.push(b?.commits[0].sha));
    expect(heard).toEqual(["a"]);
  });

  it("shows the message of a blame that failed, with the toggle still usable", async () => {
    t.blame.mockResolvedValue({ ok: false, reason: "timeout", message: "too slow" });
    t.follower.start(true);
    await flush();
    expect(t.status[t.status.length - 1]).toEqual({ available: true, note: "too slow" });
    expect(t.shown).toEqual([]);
  });

  it("blames again after a save, and after HEAD moves, but not for other workspace changes", async () => {
    t.follower.start(true);
    await flush();
    t.follower.workspaceChanged();
    await flush();
    expect(t.blame).toHaveBeenCalledTimes(1);
    t.follower.fileChanged();
    await flush();
    expect(t.blame).toHaveBeenCalledTimes(2);
    t.revision.mockResolvedValue("head2");
    t.follower.workspaceChanged();
    await flush();
    expect(t.blame).toHaveBeenCalledTimes(3);
  });

  it("runs one blame at a time, and one more for whatever came meanwhile", async () => {
    let answer!: (r: BlameResult) => void;
    t.blame.mockReturnValueOnce(new Promise((r) => (answer = r)));
    t.follower.start(true);
    await flush();
    t.follower.fileChanged();
    t.follower.fileChanged();
    t.follower.workspaceChanged();
    await flush();
    expect(t.blame).toHaveBeenCalledTimes(1);
    answer(ok("a"));
    await flush();
    expect(t.blame).toHaveBeenCalledTimes(2);
  });

  it("drops a blame read before the file changed, and shows the next", async () => {
    let answer!: (r: BlameResult) => void;
    t.blame.mockReturnValueOnce(new Promise((r) => (answer = r)));
    t.blame.mockResolvedValueOnce(ok("fresh"));
    t.follower.start(true);
    await flush();
    t.follower.fileChanged();
    answer(ok("stale"));
    await flush();
    expect(t.shown).toEqual(["fresh"]);
  });

  it("becomes available once the file is committed, while off", async () => {
    t.revision.mockResolvedValue(null);
    t.follower.start(false);
    await flush();
    t.revision.mockResolvedValue("head2");
    t.follower.workspaceChanged();
    await flush();
    expect(t.status[t.status.length - 1]).toEqual({ available: true, note: null });
  });

  it("says nothing after it stops", async () => {
    t.follower.start(true);
    t.follower.stop();
    await flush();
    expect(t.status).toEqual([]);
    expect(t.blame).not.toHaveBeenCalled();
  });
});

describe("the remembered choice", () => {
  it("follows a toggle in another window", () => {
    useBlamePref.setState({ on: false });
    window.dispatchEvent(new StorageEvent("storage", { key: "manor:fileBlame", newValue: "1" }));
    expect(useBlamePref.getState().on).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "0" }));
    expect(useBlamePref.getState().on).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: "manor:fileBlame", newValue: "0" }));
    expect(useBlamePref.getState().on).toBe(false);
  });
});
