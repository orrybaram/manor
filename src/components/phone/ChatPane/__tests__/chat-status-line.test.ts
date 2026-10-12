import { describe, expect, it } from "vitest";
import type { PrInfo } from "../../../../lib/pr-info";
import { formatContextTokens, prStatusChips } from "../chat-status-line";

const URL = "https://github.com/o/r/pull/7";

function pr(over: Partial<PrInfo>): PrInfo {
  return { number: 7, state: "open", title: "Fix it", url: URL, ...over };
}

const NO_DIFF = null;

function chips(prInfo: PrInfo | null, diffStats: { added: number; removed: number } | null = null) {
  return prStatusChips({ pr: prInfo, diffStats });
}

describe("prStatusChips", () => {
  it("shows no PR or CI without an open PR", () => {
    expect(chips(null)).toEqual({ pr: null, ci: null, diff: null });
    expect(chips(pr({ state: "merged" })).pr).toBeNull();
    expect(chips(pr({ state: "closed" })).pr).toBeNull();
  });

  it("describes the open PR", () => {
    expect(chips(pr({ isDraft: true })).pr).toEqual({ number: 7, title: "Fix it", draft: true });
  });

  it("links a failing CI chip to the first failing run", () => {
    const result = chips(
      pr({
        checks: { total: 3, passing: 1, failing: 2, pending: 0 },
        checkRuns: [
          { name: "e2e", status: "failing", url: "https://ci/e2e" },
          { name: "lint", status: "failing", url: "https://ci/lint" },
        ],
      }),
    );
    expect(result.ci).toEqual({ tone: "failing", label: "2 failing", url: "https://ci/e2e" });
  });

  it("falls back to the checks tab when the failing run has no url", () => {
    const result = chips(pr({ checks: { total: 1, passing: 0, failing: 1, pending: 0 } }));
    expect(result.ci?.url).toBe(`${URL}/checks`);
  });

  it("reports pending before passing", () => {
    expect(chips(pr({ checks: { total: 2, passing: 1, failing: 0, pending: 1 } })).ci?.tone).toBe(
      "pending",
    );
    expect(chips(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } })).ci?.tone).toBe(
      "passing",
    );
  });

  it("drops the CI chip when every check was skipped", () => {
    expect(
      chips(pr({ checks: { total: 1, passing: 0, failing: 0, pending: 0, skipped: 1 } })).ci,
    ).toBeNull();
  });

  it("uses the PR's diff stat only when GitHub sent one", () => {
    expect(chips(pr({})).diff).toBe(NO_DIFF);
    expect(chips(pr({ additions: 177, deletions: 12 })).diff).toEqual({
      additions: 177,
      deletions: 12,
    });
  });

  it("prefers local stats over the PR's", () => {
    expect(chips(pr({ additions: 177, deletions: 12 }), { added: 3, removed: 1 }).diff).toEqual({
      additions: 3,
      deletions: 1,
    });
  });

  it("falls back to the PR's stats when local stats are zero", () => {
    expect(chips(pr({ additions: 5, deletions: 2 }), { added: 0, removed: 0 }).diff).toEqual({
      additions: 5,
      deletions: 2,
    });
  });

  it("shows the local diff without a PR", () => {
    expect(chips(null, { added: 4, removed: 0 })).toEqual({
      pr: null,
      ci: null,
      diff: { additions: 4, deletions: 0 },
    });
  });

  it("shows local stats for a merged PR but not its own", () => {
    const merged = pr({ state: "merged", additions: 9, deletions: 9 });
    expect(chips(merged, { added: 2, removed: 3 }).diff).toEqual({ additions: 2, deletions: 3 });
    expect(chips(merged).diff).toBeNull();
  });
});

describe("formatContextTokens", () => {
  it("rounds to thousands", () => {
    expect(formatContextTokens(999)).toBe("<1k");
    expect(formatContextTokens(1000)).toBe("1k");
    expect(formatContextTokens(8_400)).toBe("8k");
    expect(formatContextTokens(100_200)).toBe("100k");
    expect(formatContextTokens(419_600)).toBe("420k");
  });
});
