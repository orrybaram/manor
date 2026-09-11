/**
 * Every state the PR badge can be in, as data.
 *
 * Shared so the same table drives two kinds of evidence: the unit test beside
 * this file checks the readiness function agrees, and
 * `tests/e2e/pr-badge-matrix.spec.ts` drives the real app and checks the badge
 * it actually draws.
 */
import type { PrReadiness } from "../../../src/lib/pr-readiness";

export type Check = {
  name: string;
  conclusion: string | null;
  status?: string;
  workflowName?: string;
};

export type Case = {
  branch: string;
  /** What the case is here to prove. */
  note: string;
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft?: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  rollup: Check[];
  autoMerge?: boolean;
  inMergeQueue?: boolean;
  unresolved?: number;
  expect: { readiness: PrReadiness; icon: string; spin: boolean };
};

export const PASS: Check = {
  name: "unit",
  conclusion: "SUCCESS",
  workflowName: "CI",
};
const PASS2: Check = {
  name: "lint",
  conclusion: "SUCCESS",
  workflowName: "CI",
};
const FAIL: Check = { name: "unit", conclusion: "FAILURE", workflowName: "CI" };
const RUNNING: Check = {
  name: "e2e",
  conclusion: null,
  status: "IN_PROGRESS",
  workflowName: "CI",
};
const SKIPPED: Check = {
  name: "deploy",
  conclusion: "SKIPPED",
  workflowName: "CI",
};

export const CASES: Case[] = [
  {
    branch: "a-merged",
    note: "merged outranks everything below it",
    number: 201,
    state: "MERGED",
    reviewDecision: "APPROVED",
    rollup: [PASS],
    expect: { readiness: "merged", icon: "lucide-git-merge", spin: false },
  },
  {
    branch: "b-closed",
    note: "closed, never merged",
    number: 202,
    state: "CLOSED",
    reviewDecision: null,
    rollup: [],
    expect: {
      readiness: "closed",
      icon: "lucide-git-pull-request-closed",
      spin: false,
    },
  },
  {
    branch: "c-blocked-checks",
    note: "a failing check beats an approval",
    number: 203,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [FAIL, PASS2],
    expect: { readiness: "blocked", icon: "lucide-circle-x", spin: false },
  },
  {
    branch: "d-blocked-review",
    note: "changes requested, CI green",
    number: 204,
    state: "OPEN",
    reviewDecision: "CHANGES_REQUESTED",
    rollup: [PASS],
    expect: { readiness: "blocked", icon: "lucide-shield-alert", spin: false },
  },
  {
    branch: "e-blocked-threads",
    note: "approved but threads still open",
    number: 205,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [PASS],
    unresolved: 2,
    expect: {
      readiness: "blocked",
      icon: "lucide-message-square",
      spin: false,
    },
  },
  {
    branch: "f-queued-automerge",
    note: "auto-merge armed",
    number: 206,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [PASS],
    autoMerge: true,
    expect: { readiness: "queued", icon: "lucide-loader-circle", spin: true },
  },
  {
    branch: "g-queued-mergequeue",
    note: "sitting in the repo merge queue",
    number: 207,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [PASS],
    inMergeQueue: true,
    expect: { readiness: "queued", icon: "lucide-loader-circle", spin: true },
  },
  {
    branch: "h-queued-failing",
    note: "queued but red: blocked wins, no spinner",
    number: 208,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [FAIL],
    autoMerge: true,
    expect: { readiness: "blocked", icon: "lucide-circle-x", spin: false },
  },
  {
    branch: "i-ready",
    note: "green board, approved",
    number: 209,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [PASS, PASS2],
    expect: { readiness: "ready", icon: "lucide-circle-check", spin: false },
  },
  {
    branch: "j-ci-running",
    note: "CI still going",
    number: 210,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    rollup: [PASS, RUNNING],
    expect: { readiness: "pending", icon: "lucide-loader-circle", spin: true },
  },
  {
    branch: "k-draft-ci-running",
    note: "draft with CI going: spinner plus dashed outline",
    number: 211,
    state: "OPEN",
    isDraft: true,
    reviewDecision: "REVIEW_REQUIRED",
    rollup: [RUNNING],
    expect: { readiness: "pending", icon: "lucide-loader-circle", spin: true },
  },
  {
    branch: "l-draft-green",
    note: "draft, green and approved: still a draft",
    number: 212,
    state: "OPEN",
    isDraft: true,
    reviewDecision: "APPROVED",
    rollup: [PASS],
    expect: {
      readiness: "pending",
      icon: "lucide-git-pull-request-draft",
      spin: false,
    },
  },
  {
    branch: "m-awaiting-review",
    note: "green, nobody has reviewed",
    number: 213,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    rollup: [PASS],
    expect: {
      readiness: "pending",
      icon: "lucide-git-pull-request",
      spin: false,
    },
  },
  {
    branch: "n-no-ci-approved",
    note: "no CI at all, approved — ships (the fix)",
    number: 214,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [],
    expect: { readiness: "ready", icon: "lucide-circle-check", spin: false },
  },
  {
    branch: "o-no-ci-waiting",
    note: "no CI, no review yet",
    number: 215,
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    rollup: [],
    expect: {
      readiness: "pending",
      icon: "lucide-git-pull-request",
      spin: false,
    },
  },
  {
    branch: "p-skipped-only",
    note: "every check skipped: nothing to wait for",
    number: 216,
    state: "OPEN",
    reviewDecision: "APPROVED",
    rollup: [SKIPPED],
    expect: { readiness: "ready", icon: "lucide-circle-check", spin: false },
  },
];
