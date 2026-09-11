import { describe, it, expect } from "vitest";
import { parseStatusCheckRollup } from "../../../electron/github";
import { prReadiness } from "../../../src/lib/pr-readiness";
import type { PrInfo } from "../../../src/lib/pr-info";
import { CASES, type Case } from "./pr-badge-cases";

/**
 * The readiness half of the badge matrix, without an app.
 *
 * The same table the e2e run renders, pushed through the real rollup parser
 * and the real `prReadiness`, so a change to either shows up here in
 * milliseconds instead of only in a three-minute Electron run.
 */

function toPrInfo(c: Case): PrInfo {
  const { checks } = parseStatusCheckRollup(c.rollup);
  return {
    number: c.number,
    state: c.state.toLowerCase(),
    title: c.note,
    url: `https://github.com/acme/app/pull/${c.number}`,
    isDraft: c.isDraft ?? false,
    reviewDecision: c.reviewDecision,
    checks,
    unresolvedThreads: c.unresolved ?? 0,
    queuedToMerge: c.autoMerge === true || c.inMergeQueue === true,
  };
}

describe("prReadiness across every badge state", () => {
  for (const c of CASES) {
    it(`${c.branch}: ${c.note}`, () => {
      expect(prReadiness(toPrInfo(c))).toBe(c.expect.readiness);
    });
  }
});
