import { describe, expect, it } from "vitest";
import type { PrInfo, PrMergeOptions } from "../pr-info";
import { mergeOffer } from "../pr-merge-offer";

const options: PrMergeOptions = { allowed: ["squash", "merge"], autoMergeAllowed: true, mergeQueue: false };
const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 1,
  state: "open",
  title: "t",
  url: "https://github.com/acme/app/pull/1",
  reviewDecision: "APPROVED",
  checks: { total: 2, passing: 2, failing: 0, pending: 0 },
  unresolvedThreads: 0,
  ...over,
});

describe("mergeOffer", () => {
  it("merges a ready PR now", () => {
    expect(mergeOffer(pr(), options)).toEqual({ kind: "merge" });
  });

  it("offers auto-merge while checks run, when the repo allows it", () => {
    const running = pr({ checks: { total: 2, passing: 1, failing: 0, pending: 1 } });
    expect(mergeOffer(running, options)).toEqual({ kind: "auto" });
    expect(mergeOffer(running, { ...options, autoMergeAllowed: false }).kind).toBe("none");
  });

  it("queues a PR whose base has a merge queue, even while checks run", () => {
    const running = pr({ checks: { total: 2, passing: 1, failing: 0, pending: 1 } });
    expect(mergeOffer(running, { ...options, mergeQueue: true })).toEqual({ kind: "queue" });
  });

  it("refuses failing checks, conflicts and drafts with a reason", () => {
    expect(mergeOffer(pr({ checks: { total: 2, passing: 1, failing: 1, pending: 0 } }), options)).toEqual({
      kind: "none",
      reason: "Fix the failing checks first",
    });
    expect(mergeOffer(pr({ hasConflicts: true }), options)).toEqual({
      kind: "none",
      reason: "Resolve the merge conflicts first",
    });
    expect(mergeOffer(pr({ isDraft: true }), options).kind).toBe("none");
  });

  it("leaves an unresolved thread to GitHub to enforce", () => {
    expect(mergeOffer(pr({ unresolvedThreads: 2 }), options)).toEqual({ kind: "merge" });
  });

  it("waits for the repo's settings", () => {
    expect(mergeOffer(pr(), undefined).kind).toBe("none");
  });
});
