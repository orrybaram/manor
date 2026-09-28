import { describe, it, expect } from "vitest";
import { tabBadgeHostId } from "../tab-host-badge";
import { workspaceHostId } from "../../../lib/hosts";

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

describe("the tab badge against the workspace's host", () => {
  // A linked group (ADR-192) whose two members share a workspace path: the
  // badge compares against the member whose workspace the user opened.
  const SHARED = "/home/me/.manor/worktrees/app/feat";
  const projects = [
    { id: "p-local", path: "/home/me/app", hostId: "local", workspaces: [{ path: SHARED }] },
    { id: "p-box", path: "/home/me/app", hostId: "box", workspaces: [{ path: SHARED }] },
  ];

  it("badges a box pane's tab only when the local member's workspace is open", () => {
    const onBox = workspaceHostId({ projects, selectedProjectIndex: 1 }, SHARED);
    const onLocal = workspaceHostId({ projects, selectedProjectIndex: 0 }, SHARED);
    expect(tabBadgeHostId("box", onBox)).toBeNull();
    expect(tabBadgeHostId("box", onLocal)).toBe("box");
  });
});
