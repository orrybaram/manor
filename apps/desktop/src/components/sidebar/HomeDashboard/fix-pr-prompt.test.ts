import { describe, expect, it, vi } from "vitest";
import { fixPrPrompt } from "./fix-pr-prompt";

const pr = { number: 91, title: "Retry webhook deliveries", url: "https://github.com/o/r/pull/91" };

describe("fixPrPrompt", () => {
  it("sends the PR card's brief for failing checks", async () => {
    const fetchBrief = vi.fn(async () => "the checks brief");
    const prompt = await fixPrPrompt(
      pr,
      { kind: "checks", failing: [{ name: "lint", url: null }], failingCount: 1, passing: 3, total: 4 },
      fetchBrief,
    );
    expect(prompt).toBe("the checks brief");
    expect(fetchBrief).toHaveBeenCalledWith("checks");
  });

  it("sends the PR card's brief for review threads", async () => {
    const fetchBrief = vi.fn(async () => "the threads brief");
    expect(await fixPrPrompt(pr, { kind: "threads", count: 2 }, fetchBrief)).toBe("the threads brief");
    expect(fetchBrief).toHaveBeenCalledWith("comments");
  });

  it("rejects when the brief can't be fetched", async () => {
    await expect(
      fixPrPrompt(pr, { kind: "threads", count: 1 }, async () => {
        throw new Error("gh failed");
      }),
    ).rejects.toThrow("gh failed");
  });

  const noBrief = () => Promise.reject(new Error("no fetch expected"));

  it("merges the base branch for conflicts, without force-pushing", async () => {
    const prompt = await fixPrPrompt(pr, { kind: "conflicts" }, noBrief);
    expect(prompt).toContain('PR #91 "Retry webhook deliveries" (https://github.com/o/r/pull/91)');
    expect(prompt).toContain("merge conflicts");
    expect(prompt).toContain("don't rebase or force-push");
  });

  it("points at the PR's reviews for requested changes", async () => {
    const prompt = await fixPrPrompt(pr, { kind: "changes-requested" }, noBrief);
    expect(prompt).toContain("A reviewer requested changes on");
    expect(prompt).toContain("gh pr view 91 --comments");
  });

  it("uses an edited prompt", async () => {
    expect(await fixPrPrompt(pr, { kind: "conflicts" }, noBrief, { prConflicts: "Merge #{{pr}}" })).toBe(
      `Merge #PR #91 "Retry webhook deliveries" (https://github.com/o/r/pull/91)`,
    );
  });
});
