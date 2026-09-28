import { describe, it, expect } from "vitest";
import { PortlessManager, hostSegment } from "./portless";
import { LOCAL_HOST_ID } from "./backend/types";

describe("PortlessManager.hostnameForPort", () => {
  const manager = new PortlessManager();

  it("names main by project, and a branch worktree by branch.project", () => {
    expect(manager.hostnameForPort("/repo", "acme", null, true)).toBe(
      "acme.localhost",
    );
    expect(manager.hostnameForPort("/repo", "acme", "feat/x", false)).toBe(
      "feat-x.acme.localhost",
    );
  });

  it("falls back to the workspace's basename with no project name", () => {
    expect(manager.hostnameForPort("/code/acme", null, null, true)).toBe(
      "acme.localhost",
    );
  });

  it("is unchanged for a local workspace: no host segment is added", () => {
    expect(manager.hostnameForPort("/repo", "acme", null, true, null)).toBe(
      "acme.localhost",
    );
  });

  it("inserts the host segment right before .localhost, for main and a branch alike", () => {
    expect(
      manager.hostnameForPort("/repo", "acme", null, true, "3f1c2a9e"),
    ).toBe("acme.3f1c2a9e.localhost");
    expect(
      manager.hostnameForPort("/repo", "acme", "feat/x", false, "3f1c2a9e"),
    ).toBe("feat-x.acme.3f1c2a9e.localhost");
  });
});

describe("hostSegment", () => {
  it("gives local no segment at all", () => {
    expect(hostSegment(LOCAL_HOST_ID, [LOCAL_HOST_ID, "3f1c2a9e-uuid"])).toBeNull();
  });

  it("is the first 8 characters of the id, lowercased", () => {
    expect(hostSegment("3F1C2A9E-1234-5678", [LOCAL_HOST_ID])).toBe("3f1c2a9e");
  });

  it("uses the full sanitized id when two hosts share the 8-char prefix", () => {
    const a = "3f1c2a9e-aaaa";
    const b = "3f1c2a9e-bbbb";
    expect(hostSegment(a, [LOCAL_HOST_ID, a, b])).toBe("3f1c2a9e-aaaa");
    expect(hostSegment(b, [LOCAL_HOST_ID, a, b])).toBe("3f1c2a9e-bbbb");
  });

  it("does not treat a host as colliding with itself", () => {
    const a = "3f1c2a9e-aaaa";
    expect(hostSegment(a, [LOCAL_HOST_ID, a])).toBe("3f1c2a9e");
  });
});
