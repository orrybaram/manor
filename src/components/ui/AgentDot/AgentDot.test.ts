import { describe, it, expect } from "vitest";
import { AgentDot } from "./AgentDot";
import { Tooltip } from "../Tooltip/Tooltip";

/**
 * `AgentDot` has no hooks and no context dependency, so calling it directly
 * (rather than mounting it) is enough to inspect the element tree it
 * returns — including which node the reason ends up as a tooltip on
 * (ADR-184 §4).
 */
describe("AgentDot", () => {
  it("shows the published reason as the dot's tooltip", () => {
    const el = AgentDot({
      status: "error",
      size: "pane",
      reason: "agent process exited",
    });
    expect(el?.type).toBe(Tooltip);
    expect(el?.props.label).toBe("agent process exited");
  });

  it("wraps a working/thinking spinner in the reason tooltip too", () => {
    const el = AgentDot({
      status: "working",
      size: "pane",
      reason: "PreToolUse hook",
    });
    expect(el?.type).toBe(Tooltip);
    expect(el?.props.label).toBe("PreToolUse hook");
  });

  it("renders no tooltip when no reason is given (an aggregate across panes)", () => {
    const el = AgentDot({ status: "error", size: "pane" });
    expect(el?.type).not.toBe(Tooltip);
  });

  it("returns null for idle — there is no dot for it", () => {
    expect(AgentDot({ status: "idle", size: "pane", reason: "agent process exited" })).toBeNull();
  });

  it("returns null for a missing status", () => {
    expect(AgentDot({ size: "pane" })).toBeNull();
  });
});
