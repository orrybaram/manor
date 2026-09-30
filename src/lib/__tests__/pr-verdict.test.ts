import { describe, it, expect } from "vitest";
import { blockerLabel, prVerdict } from "../pr-readiness";
import type { PrBlocker, PrVerdict } from "../pr-readiness";
import type { PrInfo } from "../pr-info";

const basePr = (overrides: Partial<PrInfo> = {}): PrInfo => ({
  number: 1,
  state: "open",
  title: "some pr",
  url: "https://github.com/example/repo/pull/1",
  ...overrides,
});

const checks = (passing: number, failing: number, pending: number) => ({
  passing,
  failing,
  pending,
  total: passing + failing + pending,
});

const MERGED: PrVerdict = { readiness: "merged", stage: null, blocker: null };
const CLOSED: PrVerdict = { readiness: "closed", stage: null, blocker: null };
const READY: PrVerdict = { readiness: "ready", stage: "ready", blocker: null };
const QUEUED: PrVerdict = { readiness: "queued", stage: "ready", blocker: null };
const REVIEW: PrVerdict = { readiness: "review", stage: "review", blocker: null };
const PENDING_REVIEW: PrVerdict = {
  readiness: "pending",
  stage: "review",
  blocker: null,
};
const PENDING_CHECKS: PrVerdict = {
  readiness: "pending",
  stage: "checks",
  blocker: null,
};
const blocked = (blocker: PrBlocker): PrVerdict => ({
  readiness: "blocked",
  stage: "blocked",
  blocker,
});
const CONFLICTS = blocked({ kind: "conflicts" });
const CHANGES = blocked({ kind: "changes-requested" });
const threads = (count: number) => blocked({ kind: "threads", count });
const failingChecks = (
  c: { passing: number; failing: number; total: number },
  failing: { name: string; url: string | null }[] = [],
) =>
  blocked({
    kind: "checks",
    failing,
    failingCount: c.failing,
    passing: c.passing,
    total: c.total,
  });

describe("prVerdict", () => {
  it.each<[string, Partial<PrInfo>, PrVerdict]>([
    // Terminal states win over everything.
    ["merged", { state: "merged" }, MERGED],
    ["closed", { state: "closed" }, CLOSED],
    ["merged even with unresolved threads", { state: "merged", unresolvedThreads: 3 }, MERGED],

    // Each blocker on its own.
    ["blocked: conflicts", { hasConflicts: true }, CONFLICTS],
    ["blocked: failing checks", { checks: checks(2, 1, 0) }, failingChecks(checks(2, 1, 0))],
    ["blocked: changes requested", { reviewDecision: "CHANGES_REQUESTED" }, CHANGES],
    ["blocked: unresolved threads", { unresolvedThreads: 2 }, threads(2)],
    [
      "blocked: unresolved threads with no checks",
      { isDraft: false, reviewDecision: "APPROVED", unresolvedThreads: 1 },
      threads(1),
    ],

    // Blocker precedence.
    [
      "conflicts over ready and queued",
      {
        hasConflicts: true,
        reviewDecision: "APPROVED",
        checks: checks(2, 0, 0),
        queuedToMerge: true,
      },
      CONFLICTS,
    ],
    [
      "conflicts over failing checks",
      { hasConflicts: true, checks: checks(1, 1, 0) },
      CONFLICTS,
    ],
    [
      "failing checks over changes requested",
      { checks: checks(1, 1, 0), reviewDecision: "CHANGES_REQUESTED" },
      failingChecks(checks(1, 1, 0)),
    ],
    [
      "changes requested over threads",
      { reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 4 },
      CHANGES,
    ],
    [
      "failing checks over ready",
      { isDraft: false, checks: checks(1, 1, 0), reviewDecision: "APPROVED" },
      failingChecks(checks(1, 1, 0)),
    ],
    [
      "failing checks over queued: a failing check keeps a queued PR from merging",
      { queuedToMerge: true, checks: checks(1, 1, 0) },
      failingChecks(checks(1, 1, 0)),
    ],
    [
      "conflicts over pending checks",
      { hasConflicts: true, checks: checks(0, 0, 2) },
      CONFLICTS,
    ],

    // Failing-checks details.
    [
      "failing runs named, with and without url, passing runs dropped",
      {
        checks: checks(1, 3, 0),
        checkRuns: [
          { name: "lint", status: "failing", url: "https://ci/lint" },
          { name: "e2e", status: "failing" },
          { name: "build", status: "passing", url: "https://ci/build" },
          { name: "types", status: "failing", url: null },
        ],
      },
      failingChecks(checks(1, 3, 0), [
        { name: "lint", url: "https://ci/lint" },
        { name: "e2e", url: null },
        { name: "types", url: null },
      ]),
    ],

    // Review required.
    [
      "review: required, checks clear, no threads",
      { isDraft: false, checks: checks(2, 0, 0), reviewDecision: "REVIEW_REQUIRED" },
      REVIEW,
    ],
    [
      "review, not ready, when required and there are no checks",
      { isDraft: false, reviewDecision: "REVIEW_REQUIRED" },
      REVIEW,
    ],
    [
      "pending, not review, for a draft with review required",
      { isDraft: true, checks: checks(2, 0, 0), reviewDecision: "REVIEW_REQUIRED" },
      PENDING_REVIEW,
    ],
    [
      "pending, not review, when review is required and checks are running",
      { isDraft: false, checks: checks(1, 0, 1), reviewDecision: "REVIEW_REQUIRED" },
      PENDING_CHECKS,
    ],
    [
      "blocked, not review, when review is required and checks are failing",
      { isDraft: false, checks: checks(1, 1, 0), reviewDecision: "REVIEW_REQUIRED" },
      failingChecks(checks(1, 1, 0)),
    ],
    [
      "blocked, not review, when review is required and there are threads",
      {
        isDraft: false,
        checks: checks(2, 0, 0),
        reviewDecision: "REVIEW_REQUIRED",
        unresolvedThreads: 1,
      },
      threads(1),
    ],
    [
      "queued, not review, when review is required but the PR is queued",
      {
        isDraft: false,
        checks: checks(2, 0, 0),
        reviewDecision: "REVIEW_REQUIRED",
        queuedToMerge: true,
      },
      QUEUED,
    ],

    // Queued.
    ["queued", { queuedToMerge: true }, QUEUED],
    [
      "queued over ready",
      {
        queuedToMerge: true,
        isDraft: false,
        checks: checks(2, 0, 0),
        reviewDecision: "APPROVED",
      },
      QUEUED,
    ],
    [
      "queued with checks still running",
      { queuedToMerge: true, checks: checks(0, 0, 1) },
      QUEUED,
    ],

    // Ready.
    [
      "ready: approved and all checks pass",
      { isDraft: false, checks: checks(2, 0, 0), reviewDecision: "APPROVED" },
      READY,
    ],
    // A repo without CI has no checks to wait for, so an approval is the
    // whole gate.
    [
      "ready: approved and the repo has no checks at all",
      { isDraft: false, reviewDecision: "APPROVED" },
      READY,
    ],

    // Pending.
    [
      "pending: draft even if everything else is green",
      { isDraft: true, checks: checks(2, 0, 0), reviewDecision: "APPROVED" },
      PENDING_REVIEW,
    ],
    [
      "pending: draft with no checks",
      { isDraft: true, reviewDecision: "APPROVED" },
      PENDING_REVIEW,
    ],
    [
      "pending in checks: approved with checks still running",
      { isDraft: false, checks: checks(1, 0, 1), reviewDecision: "APPROVED" },
      PENDING_CHECKS,
    ],
    [
      "pending: no review decision",
      { isDraft: false, checks: checks(2, 0, 0), reviewDecision: null },
      PENDING_REVIEW,
    ],
    ["pending in checks: running checks", { checks: checks(1, 0, 2) }, PENDING_CHECKS],
    [
      "pending in checks: draft with running checks",
      { isDraft: true, checks: checks(1, 0, 2) },
      PENDING_CHECKS,
    ],
    [
      "pending in review: draft with green checks",
      { isDraft: true, checks: checks(3, 0, 0) },
      PENDING_REVIEW,
    ],
    ["pending in review: nothing reported", {}, PENDING_REVIEW],
  ])("%s", (_name, overrides, expected) => {
    expect(prVerdict(basePr(overrides))).toEqual(expected);
  });
});

describe("blockerLabel", () => {
  it.each<[PrBlocker, string]>([
    [{ kind: "conflicts" }, "conflicts"],
    [
      { kind: "checks", failing: [], failingCount: 1, passing: 0, total: 1 },
      "checks failing",
    ],
    [{ kind: "changes-requested" }, "changes requested"],
    [{ kind: "threads", count: 1 }, "1 unresolved thread"],
    [{ kind: "threads", count: 3 }, "3 unresolved threads"],
  ])("%j → %s", (blocker, label) => {
    expect(blockerLabel(blocker)).toBe(label);
  });
});
