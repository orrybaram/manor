import { describe, it, expect } from "vitest";
import { diffPrEvents } from "../pr-notifications";
import type { PrInfo } from "../../store/project-store";

function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    number: 123,
    state: "OPEN",
    title: "Add feature",
    url: "https://github.com/o/r/pull/123",
    ...overrides,
  };
}

describe("diffPrEvents", () => {
  it("returns [] when prev is null/undefined (no baseline)", () => {
    expect(diffPrEvents(null, makePr())).toEqual([]);
    expect(diffPrEvents(undefined, makePr())).toEqual([]);
  });

  it("returns [] when next is null/undefined", () => {
    expect(diffPrEvents(makePr(), null)).toEqual([]);
    expect(diffPrEvents(makePr(), undefined)).toEqual([]);
  });

  it("emits a comment event when commentCount increases", () => {
    const prev = makePr({ commentCount: 1 });
    const next = makePr({ commentCount: 3 });
    const events = diffPrEvents(prev, next);
    expect(events).toEqual([
      { kind: "comment", title: "PR #123 — new comment", body: "Add feature" },
    ]);
  });

  it("does not emit a comment event when commentCount is unchanged", () => {
    const prev = makePr({ commentCount: 2 });
    const next = makePr({ commentCount: 2 });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("emits an approved event on transition to APPROVED", () => {
    const prev = makePr({ reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({ reviewDecision: "APPROVED" });
    expect(diffPrEvents(prev, next)).toEqual([
      { kind: "approved", title: "PR #123 approved", body: "Add feature" },
    ]);
  });

  it("does not re-emit approved when already APPROVED", () => {
    const prev = makePr({ reviewDecision: "APPROVED" });
    const next = makePr({ reviewDecision: "APPROVED" });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("emits a changes-requested event on transition", () => {
    const prev = makePr({ reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({ reviewDecision: "CHANGES_REQUESTED" });
    expect(diffPrEvents(prev, next)).toEqual([
      {
        kind: "changes-requested",
        title: "PR #123 — changes requested",
        body: "Add feature",
      },
    ]);
  });

  it("emits a checks-failed event when failing goes from 0 to >0", () => {
    const prev = makePr({
      checks: { total: 3, passing: 3, failing: 0, pending: 0 },
    });
    const next = makePr({
      checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([
      {
        kind: "checks-failed",
        title: "PR #123 — CI checks failing",
        body: "Add feature",
      },
    ]);
  });

  it("does not re-emit checks-failed when already failing", () => {
    const prev = makePr({
      checks: { total: 3, passing: 2, failing: 1, pending: 0 },
    });
    const next = makePr({
      checks: { total: 3, passing: 1, failing: 2, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("returns [] when nothing changed", () => {
    const prev = makePr({
      commentCount: 1,
      reviewDecision: "APPROVED",
      checks: { total: 1, passing: 1, failing: 0, pending: 0 },
    });
    const next = makePr({
      commentCount: 1,
      reviewDecision: "APPROVED",
      checks: { total: 1, passing: 1, failing: 0, pending: 0 },
    });
    expect(diffPrEvents(prev, next)).toEqual([]);
  });

  it("can emit multiple events from a single diff", () => {
    const prev = makePr({ commentCount: 0, reviewDecision: "REVIEW_REQUIRED" });
    const next = makePr({
      commentCount: 2,
      reviewDecision: "CHANGES_REQUESTED",
    });
    const kinds = diffPrEvents(prev, next).map((e) => e.kind);
    expect(kinds).toEqual(["comment", "changes-requested"]);
  });
});
