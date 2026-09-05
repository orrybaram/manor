import { describe, it, expect } from "vitest";
import { prReadiness } from "../pr-readiness";
import type { PrInfo } from "../pr-info";

const basePr = (overrides: Partial<PrInfo> = {}): PrInfo => ({
  number: 1,
  state: "open",
  title: "some pr",
  url: "https://github.com/example/repo/pull/1",
  ...overrides,
});

describe("prReadiness", () => {
  it("returns merged when state is merged", () => {
    expect(prReadiness(basePr({ state: "merged" }))).toBe("merged");
  });

  it("returns closed when state is closed", () => {
    expect(prReadiness(basePr({ state: "closed" }))).toBe("closed");
  });

  it("returns blocked when checks are failing", () => {
    const pr = basePr({
      checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    });
    expect(prReadiness(pr)).toBe("blocked");
  });

  it("returns blocked when review decision is CHANGES_REQUESTED", () => {
    const pr = basePr({ reviewDecision: "CHANGES_REQUESTED" });
    expect(prReadiness(pr)).toBe("blocked");
  });

  it("returns blocked when there are unresolved threads on an open PR", () => {
    const pr = basePr({ unresolvedThreads: 2 });
    expect(prReadiness(pr)).toBe("blocked");
  });

  it("returns pending for a draft PR even if everything else is green", () => {
    const pr = basePr({
      isDraft: true,
      checks: { total: 2, passing: 2, failing: 0, pending: 0 },
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("returns ready when approved and all checks pass", () => {
    const pr = basePr({
      isDraft: false,
      checks: { total: 2, passing: 2, failing: 0, pending: 0 },
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("ready");
  });

  it("returns pending when approved but there is no checks data", () => {
    const pr = basePr({
      isDraft: false,
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("returns pending when checks are still pending", () => {
    const pr = basePr({
      isDraft: false,
      checks: { total: 2, passing: 1, failing: 0, pending: 1 },
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("returns pending when there is no review decision", () => {
    const pr = basePr({
      isDraft: false,
      checks: { total: 2, passing: 2, failing: 0, pending: 0 },
      reviewDecision: null,
    });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("returns blocked over ready when both sets of conditions apply", () => {
    const pr = basePr({
      isDraft: false,
      checks: { total: 2, passing: 1, failing: 1, pending: 0 },
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("blocked");
  });

  it("returns merged even when there are unresolved threads (order matters)", () => {
    const pr = basePr({ state: "merged", unresolvedThreads: 3 });
    expect(prReadiness(pr)).toBe("merged");
  });
});
