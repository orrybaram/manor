import { describe, expect, it } from "vitest";
import { fixChecksPrompt } from "./fix-checks-prompt";

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
