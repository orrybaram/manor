import { describe, expect, it } from "vitest";
import { reasonBanner } from "./CloneToHostDialog";

describe("reasonBanner", () => {
  it("has no banner for a manual opening", () => {
    expect(reasonBanner("manual")).toBeNull();
    expect(reasonBanner(undefined)).toBeNull();
  });

  it("explains each reason the transfer needed input", () => {
    expect(reasonBanner("no-origin")).toContain("no origin remote");
    expect(reasonBanner("dir-taken")).toContain("already used");
  });

  it("includes the thrown message for a failure", () => {
    expect(reasonBanner("failed", "boom")).toContain("boom");
  });
});
