import { describe, it, expect } from "vitest";
import { parsePrConversationState } from "../github";

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
