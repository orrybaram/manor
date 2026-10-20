import { describe, it, expect, vi } from "vitest";
import { SessionOwners, isRemoteSessionLoss } from "../session-owners";

describe("SessionOwners", () => {
  it("gives a session to the first host that claims it, until released", () => {
    const owners = new SessionOwners();
    expect(owners.claim("pane-a", "box")).toBe(true);
    expect(owners.claim("pane-a", "box")).toBe(true);
    expect(owners.claim("pane-a", "local")).toBe(false);
    expect(owners.ownerOf("pane-a")).toBe("box");
    owners.release("pane-a");
    expect(owners.ownerOf("pane-a")).toBeUndefined();
    expect(owners.claim("pane-a", "local")).toBe(true);
  });

  it("drops a stream event about another host's session", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const owners = new SessionOwners();
    expect(owners.accept("box", { type: "data", sessionId: "pane-a", data: "x" })).toBe(true);
    expect(owners.accept("local", { type: "data", sessionId: "pane-a", data: "y" })).toBe(false);
    expect(owners.ownerOf("pane-a")).toBe("box");
  });

  it("releases a session whose shell exited, but keeps a lost remote one", () => {
    const owners = new SessionOwners();
    owners.accept("box", { type: "exit", sessionId: "pane-a", exitCode: -1, lost: true });
    expect(owners.ownerOf("pane-a")).toBe("box");
    owners.accept("box", { type: "exit", sessionId: "pane-b", exitCode: 0 });
    expect(owners.ownerOf("pane-b")).toBeUndefined();
    // The local daemon's loss still closes the pane.
    owners.accept("local", { type: "exit", sessionId: "pane-c", exitCode: -1, lost: true });
    expect(owners.ownerOf("pane-c")).toBeUndefined();
    expect(isRemoteSessionLoss("local", { type: "exit", sessionId: "p", exitCode: -1, lost: true })).toBe(false);
  });

  it("counts only a remote session still claimed as a recoverable loss", () => {
    const owners = new SessionOwners();
    owners.accept("box", { type: "exit", sessionId: "pane-a", exitCode: -1, lost: true });
    owners.accept("box", { type: "exit", sessionId: "pane-b", exitCode: 0 });
    owners.claim("pane-c", "local");
    expect(owners.isRecoverableLoss("pane-a")).toBe(true);
    expect(owners.isRecoverableLoss("pane-b")).toBe(false);
    expect(owners.isRecoverableLoss("pane-c")).toBe(false);
    expect(owners.isRecoverableLoss("pane-never")).toBe(false);
  });

  it("releases every session of a removed host, and no other host's", () => {
    const owners = new SessionOwners();
    owners.claim("pane-a", "box");
    owners.claim("pane-b", "box");
    owners.claim("pane-c", "local");
    owners.releaseHost("box");
    expect(owners.ownerOf("pane-a")).toBeUndefined();
    expect(owners.ownerOf("pane-b")).toBeUndefined();
    expect(owners.ownerOf("pane-c")).toBe("local");
    // The same box, added again under a new id, takes the session over.
    expect(owners.claim("pane-a", "box-2")).toBe(true);
  });
});
