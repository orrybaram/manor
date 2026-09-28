import { describe, it, expect } from "vitest";
import { tabBadgeHostId } from "../tab-host-badge";
import { parseWorkspaceKey, workspaceKey } from "../../../lib/workspace-key";

describe("tabBadgeHostId", () => {
  it("names the pane's host when it differs from the workspace's", () => {
    expect(tabBadgeHostId("box", "local")).toBe("box");
    expect(tabBadgeHostId("box", "vm")).toBe("box");
    expect(tabBadgeHostId("box", undefined)).toBe("box");
  });

  it("shows no badge when the pane runs on the workspace's host", () => {
    expect(tabBadgeHostId("box", "box")).toBeNull();
  });

  it("shows no badge for a pane on this machine", () => {
    expect(tabBadgeHostId(null, "box")).toBeNull();
    expect(tabBadgeHostId(undefined, "local")).toBeNull();
  });
});

describe("the tab badge against the layout's workspace key", () => {
  // A linked group (ADR-192) whose two members share a workspace path: the
  // tab bar reads the host from its layout's key (ADR-191), so the same path
  // open on each host badges against that host.
  const SHARED = "/home/me/.manor/worktrees/app/feat";
  const hostOf = (key: string) => parseWorkspaceKey(key).hostId;

  it("badges a box pane's tab only in the local workspace's layout", () => {
    expect(tabBadgeHostId("box", hostOf(workspaceKey("box", SHARED)))).toBeNull();
    expect(tabBadgeHostId("box", hostOf(workspaceKey("local", SHARED)))).toBe("box");
  });

  it("badges a box pane's tab in another remote host's layout", () => {
    expect(tabBadgeHostId("box", hostOf(workspaceKey("vm", SHARED)))).toBe("box");
  });
});
