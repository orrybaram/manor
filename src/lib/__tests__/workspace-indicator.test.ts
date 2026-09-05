import { describe, it, expect } from "vitest";
import { toWorkspaceIndicator } from "../workspace-indicator";

describe("toWorkspaceIndicator", () => {
  it("maps thinking to a non-pulsing thinking indicator", () => {
    expect(toWorkspaceIndicator("thinking", true)).toEqual({
      kind: "thinking",
      pulse: false,
    });
  });

  it("maps working to a non-pulsing working indicator", () => {
    expect(toWorkspaceIndicator("working", true)).toEqual({
      kind: "working",
      pulse: false,
    });
  });

  it("maps requires_input with pulse true to a pulsing needs_you indicator", () => {
    expect(toWorkspaceIndicator("requires_input", true)).toEqual({
      kind: "needs_you",
      pulse: true,
    });
  });

  it("maps requires_input with pulse false to a non-pulsing needs_you indicator", () => {
    expect(toWorkspaceIndicator("requires_input", false)).toEqual({
      kind: "needs_you",
      pulse: false,
    });
  });

  it("maps error to a non-pulsing needs_you indicator regardless of pulse", () => {
    expect(toWorkspaceIndicator("error", true)).toEqual({
      kind: "needs_you",
      pulse: false,
    });
  });

  it("maps responded with pulse true to a done_unread indicator", () => {
    expect(toWorkspaceIndicator("responded", true)).toEqual({
      kind: "done_unread",
      pulse: true,
    });
  });

  it("maps responded with pulse false to null", () => {
    expect(toWorkspaceIndicator("responded", false)).toBeNull();
  });

  it("maps complete to null", () => {
    expect(toWorkspaceIndicator("complete", true)).toBeNull();
  });

  it("maps idle to null", () => {
    expect(toWorkspaceIndicator("idle", true)).toBeNull();
  });

  it("maps null status to null", () => {
    expect(toWorkspaceIndicator(null, true)).toBeNull();
  });

  it("maps undefined status to null", () => {
    expect(toWorkspaceIndicator(undefined, true)).toBeNull();
  });
});
