import { describe, expect, it } from "vitest";
import { pickPaneAgent, selectPaneChatAgent } from "./pane-agent";

const base = { paneId: "p", status: "completed", createdAt: "2026-01-01" };

describe("pickPaneAgent", () => {
  it("prefers the pane's active agent, else its newest when that one errored", () => {
    const old = { ...base, createdAt: "2026-01-01" };
    const newer = { ...base, createdAt: "2026-02-01" };
    const active = { ...base, status: "active", createdAt: "2025-12-01" };
    const errored = { ...base, status: "error", createdAt: "2026-03-01" };
    expect(pickPaneAgent([old, active, newer], "p")).toBe(active);
    expect(pickPaneAgent([old, errored, newer], "p")).toBe(errored);
    expect(pickPaneAgent([{ ...base, paneId: "q" }], "p")).toBeNull();
  });

  it("gives a pane whose agents have all exited no agent", () => {
    const old = { ...base, createdAt: "2026-01-01" };
    const newer = { ...base, status: "abandoned", createdAt: "2026-02-01" };
    const staleError = { ...base, status: "error", createdAt: "2025-12-01" };
    expect(pickPaneAgent([old, newer], "p")).toBeNull();
    expect(pickPaneAgent([staleError, newer], "p")).toBeNull();
  });
});

describe("selectPaneChatAgent", () => {
  const active = { ...base, status: "active" };

  it("follows the pane's agent unless the pane is a file or a browser pane", () => {
    expect(selectPaneChatAgent([active], "p", "terminal")).toBe(active);
    expect(selectPaneChatAgent([active], "p", undefined)).toBe(active);
    expect(selectPaneChatAgent([active], "p", "file")).toBeNull();
    expect(selectPaneChatAgent([active], "p", "browser")).toBeNull();
  });

  it("gives no pane no agent", () => {
    expect(selectPaneChatAgent([active], null, "terminal")).toBeNull();
    expect(selectPaneChatAgent([active], undefined, "terminal")).toBeNull();
  });
});
