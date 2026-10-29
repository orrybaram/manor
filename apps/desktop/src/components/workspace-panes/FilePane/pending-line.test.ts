import { describe, expect, it, vi } from "vitest";
import { createPendingLines } from "./pending-line";

describe("createPendingLines", () => {
  it("hands a line to the pane once, for the file it named", () => {
    const lines = createPendingLines(() => 0);
    lines.request("p1", { path: "src/a.ts", line: 8 });
    expect(lines.take("p1", "src/other.ts")).toBeNull();
    expect(lines.take("p1", "src/a.ts")).toEqual({ path: "src/a.ts", line: 8 });
    expect(lines.take("p1", "src/a.ts")).toBeNull();
  });

  it("tells a pane's open editor about a request", () => {
    const lines = createPendingLines(() => 0);
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

  it("drops a request that waited too long for its file", () => {
    let t = 0;
    const lines = createPendingLines(() => t);
    lines.request("p1", { path: "a.ts", line: 5 });
    t = 60_000;
    expect(lines.take("p1", "a.ts")).toBeNull();
  });
});
