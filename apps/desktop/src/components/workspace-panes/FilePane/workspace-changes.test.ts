import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileAuthor } from "../../../electron.d";
import { setDiffFingerprints } from "../../../lib/diff-fingerprints";
import { workspaceKey } from "../../../lib/workspace-key";
import { followWorkspaceChanges, type WorkspaceChanges } from "./workspace-changes";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const by = (paneId: string, at: number): FileAuthor => ({ paneId, agentKind: "claude", at });

afterEach(() => {
  vi.unstubAllGlobals();
  setDiffFingerprints({});
});

describe("workspace changes", () => {
  it("drops an older read that answers after a newer one", async () => {
    const ws = { hostId: "local", path: "/repo-stale" };
    const key = workspaceKey(ws.hostId, ws.path);
    const authors = [deferred<Record<string, FileAuthor>>(), deferred<Record<string, FileAuthor>>()];
    const getFileAuthors = vi.fn(() => authors[getFileAuthors.mock.calls.length - 1].promise);
    vi.stubGlobal("window", {
      electronAPI: {
        diffs: { getLocalDiff: vi.fn(async () => null) },
        agents: { getFileAuthors },
      },
    });
    setDiffFingerprints({ [key]: "a" });
    const seen: WorkspaceChanges[] = [];
    const stop = followWorkspaceChanges(ws, (changes) => seen.push(changes));

    // The diff watcher moves while the first authors request is still out.
    await vi.waitFor(() => expect(getFileAuthors).toHaveBeenCalledTimes(1));
    setDiffFingerprints({ [key]: "b" });
    await vi.waitFor(() => expect(getFileAuthors).toHaveBeenCalledTimes(2));

    authors[1].resolve({ "a.ts": by("new", 2) });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    authors[0].resolve({ "a.ts": by("old", 1) });
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
    expect(seen[0].authors).toEqual({ "a.ts": by("new", 2) });
    stop();
  });
});
