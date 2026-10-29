import { describe, expect, it, vi } from "vitest";
import { createPendingLines } from "./pending-line";

describe("createPendingLines", () => {
  it("hands a line to the pane once, for the file it named", () => {
    const lines = createPendingLines();
    lines.request("p1", { path: "src/a.ts", line: 8 });
    expect(lines.take("p1", "src/other.ts")).toBeNull();
    expect(lines.take("p1", "src/a.ts")).toEqual({ path: "src/a.ts", line: 8 });
    expect(lines.take("p1", "src/a.ts")).toBeNull();
  });

  it("tells a pane's open editor about a request", () => {
    const lines = createPendingLines();
    const heard = vi.fn();
    const stop = lines.subscribe("p1", heard);
    lines.request("p2", { path: "a.ts", line: 1 });
    expect(heard).not.toHaveBeenCalled();
    lines.request("p1", { path: "a.ts", line: 3, col: 2 });
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    lines.request("p1", { path: "a.ts", line: 4 });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("keeps a request however long its file takes, until it is cleared", () => {
    const lines = createPendingLines();
    const request = lines.request("p1", { path: "a.ts", line: 5 });
    expect(lines.waiting("p1")).toBe(request);
    lines.clearLine("p1");
    expect(lines.waiting("p1")).toBeNull();
    expect(lines.take("p1", "a.ts")).toBeNull();
  });

  it("tells a later request from an earlier one", () => {
    const lines = createPendingLines();
    const first = lines.request("p1", { path: "a.ts", line: 5 });
    lines.request("p1", { path: "a.ts", line: 5 });
    expect(lines.waiting("p1")).not.toBe(first);
  });

  it("nudges a pane's listeners without leaving a line to take", () => {
    const lines = createPendingLines();
    const heard = vi.fn();
    lines.subscribe("p1", heard);
    lines.nudge("p1");
    lines.nudge("p2");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(lines.take("p1", "a.ts")).toBeNull();
  });
});
