import { describe, expect, it } from "vitest";
import { inputOf, KEEP_ALL, parseKeepLast, parseMinute, type Draft } from "../draft";

describe("draft", () => {
  it("reads Keep last as 1 to 20, or cleared", () => {
    expect(parseKeepLast("")).toBeUndefined();
    expect(parseKeepLast("5")).toBe(5);
    expect(parseKeepLast("20")).toBe(20);
    expect(parseKeepLast("21")).toBeNull();
    expect(parseKeepLast("0")).toBeNull();
    expect(parseKeepLast("2.5")).toBeNull();
  });

  it("reads an hourly minute as 0 to 59, never an empty field", () => {
    expect(parseMinute("")).toBeNull();
    expect(parseMinute("0")).toBe(0);
    expect(parseMinute("59")).toBe(59);
    expect(parseMinute("60")).toBeNull();
  });

  it("stores a cleared Keep last as a plain new workspace", () => {
    const draft = {
      hostId: "local",
      name: "n",
      enabled: false,
      schedule: { cron: "0 9 * * *", timezone: "UTC" },
      projectId: "p",
      prompt: "x",
      agentKind: "claude",
      workspace: KEEP_ALL,
    } as Draft;
    const input = inputOf(draft);
    expect(input.workspace).toEqual({ mode: "new" });
    expect("hostId" in input).toBe(false);
  });
});
