import { describe, expect, it } from "vitest";
import {
  actionsJobId,
  failingChecksPrompt,
  LOG_BUDGET_CHARS,
  mergeArgs,
  mergeOptionsQueryArgs,
  mergeOutcomeQueryArgs,
  parseMergeOptions,
  parseMergeOutcome,
  prContextQueryArgs,
  parsePrContext,
  reviewThreadsPrompt,
  tailFailedLog,
} from "./github-pr-actions";

const repo = (r: Record<string, unknown>) => JSON.stringify({ data: { repository: r } });
const PR = { number: 7, title: "Add merge", url: "https://github.com/acme/app/pull/7" };

describe("parseMergeOptions", () => {
  it("puts the repo's default first and keeps only allowed methods", () => {
    expect(
      parseMergeOptions(
        repo({
          viewerDefaultMergeMethod: "REBASE",
          squashMergeAllowed: true,
          mergeCommitAllowed: false,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
        }),
      ),
    ).toEqual({ allowed: ["rebase", "squash"], autoMergeAllowed: true, mergeQueue: false });
  });

  it("falls back to the first allowed method when the default is disallowed", () => {
    expect(
      parseMergeOptions(
        repo({
          viewerDefaultMergeMethod: "SQUASH",
          squashMergeAllowed: false,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: true,
        }),
      ),
    ).toEqual({ allowed: ["merge", "rebase"], autoMergeAllowed: false, mergeQueue: false });
  });

  it("says when the PR's base branch has a merge queue", () => {
    expect(
      parseMergeOptions(
        repo({ squashMergeAllowed: true, pullRequest: { isMergeQueueEnabled: true } }),
      ).mergeQueue,
    ).toBe(true);
  });

  it("throws when GitHub returns no repository", () => {
    expect(() => parseMergeOptions(JSON.stringify({ data: {} }))).toThrow(/merge settings/);
  });
});

describe("mergeArgs", () => {
  it("names the method and arms auto-merge on request, never deleting the branch", () => {
    expect(mergeArgs(7, "squash", false)).toEqual(["pr", "merge", "7", "--squash"]);
    expect(mergeArgs(7, "rebase", true)).toEqual(["pr", "merge", "7", "--rebase", "--auto"]);
  });
});

describe("actionsJobId", () => {
  it("reads the job id from an Actions check URL", () => {
    expect(actionsJobId("https://github.com/acme/app/actions/runs/111/job/222")).toBe("222");
    expect(actionsJobId("https://ci.example.com/build/9")).toBeNull();
    expect(actionsJobId(null)).toBeNull();
  });
});

describe("tailFailedLog", () => {
  it("drops the job, step and timestamp columns and keeps the last lines", () => {
    const raw = [
      "test\tRun tests\t2026-10-30T10:00:00.0000000Z one",
      "test\tRun tests\t2026-10-30T10:00:01.0000000Z \x1b[31mtwo\x1b[0m",
      "test\tRun tests\t2026-10-30T10:00:02.0000000Z three",
      "",
    ].join("\n");
    expect(tailFailedLog(raw, 2)).toBe("two\nthree");
  });
});

describe("parsePrContext", () => {
  it("keeps unresolved threads with a body, with their line, and flattens the rollup", () => {
    const ctx = parsePrContext(
      repo({
        pullRequest: {
          ...PR,
          reviewThreads: {
            nodes: [
              { isResolved: true, path: "a.ts", line: 1, comments: { nodes: [{ body: "done", author: { login: "x" } }] } },
              {
                isResolved: false,
                isOutdated: true,
                path: "b.ts",
                line: null,
                originalLine: 12,
                comments: { nodes: [{ body: "Rename this", author: { login: "jane" }, url: "u1" }] },
              },
              { isResolved: false, path: "c.ts", line: 3, comments: { nodes: [{ body: "  " }] } },
            ],
          },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "unit",
                          conclusion: "FAILURE",
                          checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      }),
    );
    expect(ctx.threads).toEqual([
      {
        path: "b.ts",
        line: 12,
        startLine: null,
        isOutdated: true,
        comments: [{ author: "jane", body: "Rename this", url: "u1" }],
      },
    ]);
    expect(ctx.rollup).toEqual([
      { __typename: "CheckRun", name: "unit", conclusion: "FAILURE", workflowName: "CI" },
    ]);
  });
});

describe("failingChecksPrompt", () => {
  it("names each check, links it and quotes its log tail", () => {
    const prompt = failingChecksPrompt(PR, [
      { name: "typecheck", workflow: "CI", url: "https://x/job/1", logTail: "error TS2322" },
      { name: "lint", workflow: null, url: null, logTail: null },
    ]);
    expect(prompt).toContain("2 checks failing on PR #7 (Add merge), https://github.com/acme/app/pull/7");
    expect(prompt).toContain("## typecheck (CI)\nhttps://x/job/1");
    expect(prompt).toContain("```\nerror TS2322\n```");
    expect(prompt).toContain("## lint\n\nNo log could be fetched");
  });

  it("keeps the logs within one budget", () => {
    const big = "x".repeat(LOG_BUDGET_CHARS);
    const prompt = failingChecksPrompt(PR, [
      { name: "a", workflow: null, url: null, logTail: big },
      { name: "b", workflow: null, url: null, logTail: "only this" },
    ]);
    expect(prompt).not.toContain("only this");
    expect(prompt.length).toBeLessThan(LOG_BUDGET_CHARS + 1000);
  });
});

describe("reviewThreadsPrompt", () => {
  it("lists each thread with file and line and every comment in it", () => {
    const prompt = reviewThreadsPrompt(PR, [
      {
        path: "src/a.ts",
        line: 42,
        startLine: 40,
        isOutdated: false,
        comments: [
          { author: "jane", body: "Handle null here", url: "https://c/1" },
          { author: "me", body: "Which null?", url: "https://c/2" },
        ],
      },
      { path: null, line: null, startLine: null, isOutdated: false, comments: [{ author: "", body: "Overall nit", url: "" }] },
    ]);
    expect(prompt).toContain("2 unresolved review threads on PR #7");
    expect(prompt).toContain("## 1. `src/a.ts:40-42`\n@jane: Handle null here\n@me: Which null?\nhttps://c/1");
    expect(prompt).toContain("## 2. General\n@ghost: Overall nit");
  });
});

describe("the queries", () => {
  // A brace short is a GraphQL syntax error that only GitHub would catch.
  it.each([
    ["mergeOptions", mergeOptionsQueryArgs(7)],
    ["mergeOutcome", mergeOutcomeQueryArgs(7)],
    ["prContext", prContextQueryArgs(7)],
  ])("%s query balances its braces and parentheses", (_, args) => {
    const query = args.find((a) => a.startsWith("query="))!;
    const count = (c: string) => query.split(c).length - 1;
    expect(count("{")).toBe(count("}"));
    expect(count("(")).toBe(count(")"));
  });
});

describe("parseMergeOutcome", () => {
  const pr = (p: Record<string, unknown>) => repo({ pullRequest: p });
  it("tells a merge from a queued PR from armed auto-merge", () => {
    expect(parseMergeOutcome(pr({ state: "MERGED" }))).toBe("merged");
    expect(parseMergeOutcome(pr({ state: "OPEN", isInMergeQueue: true }))).toBe("queued");
    expect(parseMergeOutcome(pr({ state: "OPEN", autoMergeRequest: { enabledAt: "x" } }))).toBe("auto");
    expect(() => parseMergeOutcome(pr({ state: "OPEN" }))).toThrow(/neither merged nor queued/);
  });
});
