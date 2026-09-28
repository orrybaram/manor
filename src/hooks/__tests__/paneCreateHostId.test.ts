/**
 * Which host a pane's new (or reset) session is created on (ADR-191).
 */
import { describe, it, expect } from "vitest";
import { paneCreateHostId } from "../useTerminalConnection";
import { HOME_PATH } from "../../lib/home-path";
import type { RemotePane } from "../../store/remote-pane-store";

// The same repo at the same paths on this machine and on "box".
const SHARED = "/home/me/.manor/worktrees/app/feat";
const projects = [
  { id: "p-local", path: "/home/me/app", hostId: "local", workspaces: [{ path: SHARED }] },
  { id: "p-box", path: "/home/me/app", hostId: "box", workspaces: [{ path: SHARED }] },
];
const boxSelected = { projects, selectedProjectIndex: 1 };
const localSelected = { projects, selectedProjectIndex: 0 };

const noPanes = { panes: {} as Record<string, RemotePane> };
function runningOn(paneId: string, hostId: string) {
  return {
    panes: {
      [paneId]: { hostId, awaiting: false, reattachEpoch: 0, reattachPending: false },
    },
  };
}

describe("paneCreateHostId", () => {
  it("uses the host of the workspace the pane belongs to", () => {
    expect(paneCreateHostId("pane-1", SHARED, noPanes, boxSelected)).toBe("box");
    expect(paneCreateHostId("pane-1", SHARED, noPanes, localSelected)).toBe("local");
  });

  it("keeps a pane on the remote host it is known to run on", () => {
    // Moved there, or its project moved away from it (ADR-183).
    expect(paneCreateHostId("pane-1", SHARED, runningOn("pane-1", "box"), localSelected)).toBe(
      "box",
    );
    // Another pane's host is not this one's.
    expect(paneCreateHostId("pane-2", SHARED, runningOn("pane-1", "box"), localSelected)).toBe(
      "local",
    );
  });

  it("puts a Home pane on this machine", () => {
    expect(paneCreateHostId("pane-1", HOME_PATH, noPanes, boxSelected)).toBe("local");
  });

  it("names no host for a path no project has", () => {
    expect(paneCreateHostId("pane-1", "/tmp", noPanes, boxSelected)).toBeUndefined();
  });
});
