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

  // A repo without CI has no checks to wait for, so an approval is the whole
  // gate. Treating absent checks as "not yet green" left such a PR grey
  // forever — the badge could never say the one thing it exists to say.
  it("returns ready when approved and the repo has no checks at all", () => {
    const pr = basePr({
      isDraft: false,
      reviewDecision: "APPROVED",
    });
    expect(prReadiness(pr)).toBe("ready");
  });

  it("still requires the approval when there are no checks", () => {
    const pr = basePr({ isDraft: false, reviewDecision: "REVIEW_REQUIRED" });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("still respects draft when there are no checks", () => {
    const pr = basePr({ isDraft: true, reviewDecision: "APPROVED" });
    expect(prReadiness(pr)).toBe("pending");
  });

  it("still respects unresolved threads when there are no checks", () => {
    const pr = basePr({
      isDraft: false,
      reviewDecision: "APPROVED",
      unresolvedThreads: 1,
    });
    expect(prReadiness(pr)).toBe("blocked");
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

  it("returns queued when auto-merge is armed or the PR is in the merge queue", () => {
    expect(prReadiness(basePr({ queuedToMerge: true }))).toBe("queued");
    expect(
      prReadiness(
        basePr({
          queuedToMerge: true,
          isDraft: false,
          checks: { total: 2, passing: 2, failing: 0, pending: 0 },
          reviewDecision: "APPROVED",
        }),
      ),
    ).toBe("queued");
  });

  it("returns blocked over queued: a failing check keeps a queued PR from merging", () => {
    const pr = basePr({
      queuedToMerge: true,
      checks: { total: 2, passing: 1, failing: 1, pending: 0 },
    });
    expect(prReadiness(pr)).toBe("blocked");
  });

  it("returns merged even when there are unresolved threads (order matters)", () => {
    const pr = basePr({ state: "merged", unresolvedThreads: 3 });
    expect(prReadiness(pr)).toBe("merged");
  });
});
