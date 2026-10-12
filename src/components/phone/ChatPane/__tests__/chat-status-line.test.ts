import { describe, expect, it } from "vitest";
import type { PrInfo } from "../../../../lib/pr-info";
import { prStatusChips } from "../chat-status-line";

const URL = "https://github.com/o/r/pull/7";

function pr(over: Partial<PrInfo>): PrInfo {
  return { number: 7, state: "open", title: "Fix it", url: URL, ...over };
}

describe("prStatusChips", () => {
  it("shows nothing without an open PR", () => {
    expect(prStatusChips(null)).toBeNull();
    expect(prStatusChips(pr({ state: "merged" }))).toBeNull();
    expect(prStatusChips(pr({ state: "closed" }))).toBeNull();
  });

  it("links a failing CI chip to the first failing run", () => {
    const chips = prStatusChips(
      pr({
        checks: { total: 3, passing: 1, failing: 2, pending: 0 },
        checkRuns: [
          { name: "e2e", status: "failing", url: "https://ci/e2e" },
          { name: "lint", status: "failing", url: "https://ci/lint" },
        ],
      }),
    );
    expect(chips?.ci).toEqual({ tone: "failing", label: "2 failing", url: "https://ci/e2e" });
  });

  it("falls back to the checks tab when the failing run has no url", () => {
    const chips = prStatusChips(
      pr({ checks: { total: 1, passing: 0, failing: 1, pending: 0 } }),
    );
    expect(chips?.ci?.url).toBe(`${URL}/checks`);
  });

  it("reports pending before passing", () => {
    expect(
      prStatusChips(pr({ checks: { total: 2, passing: 1, failing: 0, pending: 1 } }))?.ci?.tone,
    ).toBe("pending");
    expect(
      prStatusChips(pr({ checks: { total: 2, passing: 2, failing: 0, pending: 0 } }))?.ci?.tone,
    ).toBe("passing");
  });

  it("drops the CI chip when every check was skipped", () => {
    expect(
      prStatusChips(pr({ checks: { total: 1, passing: 0, failing: 0, pending: 0, skipped: 1 } }))
        ?.ci,
    ).toBeNull();
  });

  it("carries the diff stat only when GitHub sent one", () => {
    expect(prStatusChips(pr({}))?.diff).toBeNull();
    expect(prStatusChips(pr({ additions: 177, deletions: 12 }))?.diff).toEqual({
      additions: 177,
      deletions: 12,
      url: `${URL}/files`,
    });
  });
});
