import { describe, it, expect } from "vitest";
import { parsePrConversationState, parseStatusCheckRollup } from "../github";

/**
 * The reduction of the conversation GraphQL response (#177). The network
 * half is a `gh` invocation and is not mocked; this is the part with
 * decisions in it.
 */
describe("parsePrConversationState", () => {
  const comment = {
    author: { login: "alice" },
    body: "Looks good, one nit.",
    url: "https://github.com/o/r/pull/1#issuecomment-1",
    createdAt: "2026-09-05T10:00:00Z",
  };
  const review = {
    author: { login: "bob" },
    body: "Please rename this.",
    url: "https://github.com/o/r/pull/1#pullrequestreview-2",
    submittedAt: "2026-09-05T11:00:00Z",
  };

  it("returns {} for a missing pull request", () => {
    expect(parsePrConversationState(null)).toEqual({});
    expect(parsePrConversationState(undefined)).toEqual({});
  });

  it("counts unresolved threads and sums comments with reviews", () => {
    const state = parsePrConversationState({
      reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] },
      comments: { totalCount: 2, nodes: [comment] },
      reviews: { totalCount: 1, nodes: [review] },
    });
    expect(state.unresolvedThreads).toBe(1);
    expect(state.commentCount).toBe(3);
  });

  it("picks whichever of the newest comment and newest review is later", () => {
    const state = parsePrConversationState({
      comments: { totalCount: 1, nodes: [comment] },
      reviews: { totalCount: 1, nodes: [review] },
    });
    expect(state.latestComment).toEqual({
      author: "bob",
      body: "Please rename this.",
      url: review.url,
      createdAt: review.submittedAt,
    });

    const flipped = parsePrConversationState({
      comments: {
        totalCount: 1,
        nodes: [{ ...comment, createdAt: "2026-09-05T12:00:00Z" }],
      },
      reviews: { totalCount: 1, nodes: [review] },
    });
    expect(flipped.latestComment?.author).toBe("alice");
  });

  it("is null when the PR has no conversation, undefined when counts are unknown", () => {
    expect(
      parsePrConversationState({
        comments: { totalCount: 0, nodes: [] },
        reviews: { totalCount: 0, nodes: [] },
      }).latestComment,
    ).toBeNull();

    expect(parsePrConversationState({}).latestComment).toBeUndefined();
  });

  it("tolerates a deleted author and a bodiless review", () => {
    const state = parsePrConversationState({
      comments: { totalCount: 0, nodes: [] },
      reviews: {
        totalCount: 1,
        nodes: [{ author: null, body: "", url: review.url, submittedAt: review.submittedAt }],
      },
    });
    expect(state.latestComment).toEqual({
      author: "",
      body: "",
      url: review.url,
      createdAt: review.submittedAt,
    });
  });
});

describe("recentComments", () => {
  const comment = {
    author: { login: "alice" },
    body: "Looks good, one nit.",
    url: "https://github.com/o/r/pull/1#issuecomment-1",
    createdAt: "2026-09-05T10:00:00Z",
  };

  it("interleaves comments, reviews and threads newest first", () => {
    const state = parsePrConversationState({
      reviewThreads: {
        nodes: [
          {
            isResolved: false,
            path: "src/app.ts",
            comments: {
              nodes: [
                {
                  author: { login: "carol" },
                  body: "This leaks.",
                  url: "https://github.com/o/r/pull/1#discussion_r1",
                  createdAt: "2026-09-05T12:00:00Z",
                },
              ],
            },
          },
        ],
      },
      comments: { totalCount: 1, nodes: [comment] },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            author: { login: "bob" },
            body: "",
            url: "https://github.com/o/r/pull/1#pullrequestreview-2",
            submittedAt: "2026-09-05T11:00:00Z",
            state: "APPROVED",
          },
        ],
      },
    });

    expect(state.recentComments?.map((c) => [c.author, c.kind])).toEqual([
      ["carol", "thread"],
      ["bob", "review"],
      ["alice", "comment"],
    ]);
    expect(state.recentComments?.[0].path).toBe("src/app.ts");
    expect(state.recentComments?.[0].isResolved).toBe(false);
    expect(state.recentComments?.[1].reviewState).toBe("APPROVED");
  });

  it("drops the empty review GitHub wraps around inline comments", () => {
    const state = parsePrConversationState({
      comments: { totalCount: 0, nodes: [] },
      reviews: {
        totalCount: 1,
        nodes: [
          {
            author: { login: "bob" },
            body: "   ",
            url: "https://github.com/o/r/pull/1#pullrequestreview-3",
            submittedAt: "2026-09-05T11:00:00Z",
            state: "COMMENTED",
          },
        ],
      },
    });
    expect(state.recentComments).toEqual([]);
  });
});

describe("parseStatusCheckRollup", () => {
  it("returns no checks for an empty rollup", () => {
    expect(parseStatusCheckRollup([])).toEqual({ checks: null });
    expect(parseStatusCheckRollup(undefined)).toEqual({ checks: null });
  });

  it("counts runs and names them, failing first", () => {
    const { checks, checkRuns } = parseStatusCheckRollup([
      {
        name: "unit",
        conclusion: "SUCCESS",
        detailsUrl: "https://github.com/o/r/runs/1",
        workflowName: "CI",
      },
      { name: "build", conclusion: null, status: "IN_PROGRESS" },
      {
        name: "lint",
        conclusion: "FAILURE",
        detailsUrl: "https://github.com/o/r/runs/3",
        workflowName: "CI",
      },
    ]);

    expect(checks).toEqual({ total: 3, passing: 1, failing: 1, pending: 1 });
    expect(checkRuns?.map((r) => [r.name, r.status])).toEqual([
      ["lint", "failing"],
      ["build", "pending"],
      ["unit", "passing"],
    ]);
    expect(checkRuns?.[0].url).toBe("https://github.com/o/r/runs/3");
    expect(checkRuns?.[0].workflow).toBe("CI");
  });

  it("reads legacy status contexts, which carry state and a target url", () => {
    const { checkRuns } = parseStatusCheckRollup([
      {
        context: "ci/legacy",
        state: "FAILURE",
        targetUrl: "https://ci.example/1",
      },
    ]);
    expect(checkRuns).toEqual([
      {
        name: "ci/legacy",
        status: "failing",
        url: "https://ci.example/1",
        workflow: null,
      },
    ]);
  });
});
