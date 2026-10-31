import { describe, expect, it } from "vitest";
import type { PrInfo } from "../../../../lib/pr-info";
import {
  branchChip,
  formatContextTokens,
  modelDisplayName,
  runningChipLabel,
  shortBranchName,
  statusLineModel,
} from "../chat-status-line";

const URL = "https://github.com/o/r/pull/7";

function pr(over: Partial<PrInfo>): PrInfo {
  return { number: 7, state: "open", title: "Fix it", url: URL, ...over };
}

const NO_DIFF = null;

function chips(prInfo: PrInfo | null, diffStats: { added: number; removed: number } | null = null) {
  return statusLineModel({ pr: prInfo, diffStats });
}

describe("statusLineModel", () => {
  it("shows no PR or CI without an open PR", () => {
    expect(chips(null)).toEqual({ pr: null, ci: null, diff: null });
    expect(chips(pr({ state: "merged" })).pr).toBeNull();
    expect(chips(pr({ state: "closed" })).pr).toBeNull();
  });

  it("passes the open PR through", () => {
    const draft = pr({ isDraft: true });
    expect(chips(draft).pr).toBe(draft);
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

describe("runningChipLabel", () => {
  it("shows the count only while something runs", () => {
    expect(runningChipLabel(0)).toBeNull();
    expect(runningChipLabel(3)).toBe("3 running");
  });
});

describe("modelDisplayName", () => {
  it("names a Claude model by family and version", () => {
    expect(modelDisplayName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelDisplayName("claude-haiku-5-5")).toBe("Haiku 5.5");
    expect(modelDisplayName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelDisplayName("claude-opus-4")).toBe("Opus 4");
  });

  it("drops a date suffix and a context tag", () => {
    expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelDisplayName("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(modelDisplayName("claude-sonnet-4-5-20250929[1m]")).toBe("Sonnet 4.5");
  });

  it("reads the older version-first ids", () => {
    expect(modelDisplayName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  });

  it("shows anything else as written", () => {
    expect(modelDisplayName("gpt-5.5-codex")).toBe("gpt-5.5-codex");
    expect(modelDisplayName("claude-opus")).toBe("claude-opus");
    expect(modelDisplayName("")).toBe("");
  });
});

describe("shortBranchName", () => {
  it("keeps the part after the last slash", () => {
    expect(shortBranchName("feat/chat-session-info")).toBe("chat-session-info");
    expect(shortBranchName("orry/feat/x")).toBe("x");
    expect(shortBranchName("main")).toBe("main");
    expect(shortBranchName("odd/")).toBe("odd/");
  });
});

describe("branchChip", () => {
  it("needs a workspace branch", () => {
    expect(branchChip(undefined, "main")).toBeNull();
    expect(branchChip("", "main")).toBeNull();
  });

  it("flags a transcript branch that differs", () => {
    expect(branchChip("feat/x", "main")).toEqual({ branch: "feat/x", agentBranch: "main" });
  });

  it("does not flag an agreeing or missing transcript branch", () => {
    expect(branchChip("feat/x", "feat/x")).toEqual({ branch: "feat/x", agentBranch: null });
    expect(branchChip("Feat/X", "feat/x")).toEqual({ branch: "Feat/X", agentBranch: null });
    expect(branchChip("feat/x", null)).toEqual({ branch: "feat/x", agentBranch: null });
  });

  it("does not flag a detached checkout, which the transcript names HEAD", () => {
    expect(branchChip("73970ed", "HEAD")).toEqual({ branch: "73970ed", agentBranch: null });
  });
});
