import { describe, expect, it } from "vitest";
import { fixChecksPrompt, fixPrPrompt } from "./fix-pr-prompt";

const pr = { number: 91, title: "Retry webhook deliveries", url: "https://github.com/o/r/pull/91" };

describe("fixChecksPrompt", () => {
  it("names the PR and each failing check with its URL", () => {
    const prompt = fixChecksPrompt(
      pr,
      [
        { name: "integration / postgres", url: "https://github.com/o/r/runs/1" },
        { name: "lint", url: null },
      ],
      2,
    );
    expect(prompt).toContain('PR #91 "Retry webhook deliveries" (https://github.com/o/r/pull/91)');
    expect(prompt).toContain(
      "Failing checks: integration / postgres (https://github.com/o/r/runs/1), lint.",
    );
    expect(prompt).toContain("reproduce each failure locally");
    expect(prompt).toContain("push");
    expect(prompt).not.toContain("more failing");
  });

  it("mentions failing checks it has no names for", () => {
    const prompt = fixChecksPrompt(pr, [{ name: "lint", url: null }], 3);
    expect(prompt).toContain("2 more failing checks are listed on the PR.");
  });

  it("works with no named runs", () => {
    const prompt = fixChecksPrompt(pr, [], 1);
    expect(prompt).not.toContain("Failing checks:");
    expect(prompt).toContain("1 more failing check is listed on the PR.");
  });
});

describe("fixPrPrompt", () => {
  it("delegates checks to fixChecksPrompt", () => {
    const prompt = fixPrPrompt(pr, {
      kind: "checks",
      failing: [{ name: "lint", url: null }],
      failingCount: 1,
      passing: 3,
      total: 4,
    });
    expect(prompt).toBe(fixChecksPrompt(pr, [{ name: "lint", url: null }], 1));
  });

  it("merges the base branch for conflicts, without force-pushing", () => {
    const prompt = fixPrPrompt(pr, { kind: "conflicts" });
    expect(prompt).toContain('PR #91 "Retry webhook deliveries"');
    expect(prompt).toContain("merge conflicts");
    expect(prompt).toContain("don't rebase or force-push");
  });

  it("points at the reviews for requested changes", () => {
    const prompt = fixPrPrompt(pr, { kind: "changes-requested" });
    expect(prompt).toContain("requested changes");
    expect(prompt).toContain("gh pr view 91 --comments");
  });

  it("counts unresolved threads", () => {
    expect(fixPrPrompt(pr, { kind: "threads", count: 1 })).toContain("1 unresolved review thread.");
    expect(fixPrPrompt(pr, { kind: "threads", count: 5 })).toContain("5 unresolved review threads.");
  });
});
