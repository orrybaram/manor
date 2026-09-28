/**
 * Which host a pane's new (or reset) session is created on (ADR-191).
 */
import { describe, it, expect } from "vitest";
import { paneCreateHostId } from "../useTerminalConnection";
import { HOME_PATH } from "../../lib/home-path";
import { workspaceKey } from "../../lib/workspace-key";
import type { RemotePane } from "../../store/remote-pane-store";

// The same repo at the same paths on this machine and on "box".
const SHARED = "/home/me/.manor/worktrees/app/feat";
const onBox = workspaceKey("box", SHARED);
const onLocal = workspaceKey("local", SHARED);

const noPanes = { panes: {} as Record<string, RemotePane> };
function runningOn(paneId: string, hostId: string) {
  return {
    panes: {
      [paneId]: { hostId, awaiting: false, reattachEpoch: 0, reattachPending: false },
    },
  };
}

describe("paneCreateHostId", () => {
  it("uses the host named by the key of the workspace the pane belongs to", () => {
    expect(paneCreateHostId("pane-1", onBox, noPanes)).toBe("box");
    expect(paneCreateHostId("pane-1", onLocal, noPanes)).toBe("local");
  });

  it("keeps a pane on the remote host it is known to run on", () => {
    // Moved there, or its project moved away from it (ADR-183).
    expect(paneCreateHostId("pane-1", onLocal, runningOn("pane-1", "box"))).toBe("box");
    // Another pane's host is not this one's.
    expect(paneCreateHostId("pane-2", onLocal, runningOn("pane-1", "box"))).toBe("local");
  });

  it("puts a Home pane on this machine", () => {
    expect(paneCreateHostId("pane-1", HOME_PATH, noPanes)).toBe("local");
  });

  it("names no host for a pane with no workspace, so main uses its cwd", () => {
    expect(paneCreateHostId("pane-1", undefined, noPanes)).toBeUndefined();
    expect(paneCreateHostId("pane-1", null, noPanes)).toBeUndefined();
  });
});
