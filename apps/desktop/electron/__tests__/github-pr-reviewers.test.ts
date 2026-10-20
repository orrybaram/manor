import { describe, expect, it } from "vitest";
import { prReviewers, type RawPr } from "../github-pr-query";

function pr(overrides: Partial<RawPr>): RawPr {
  return {
    number: 1,
    state: "OPEN",
    title: "t",
    url: "https://github.com/o/r/pull/1",
    isDraft: false,
    additions: 0,
    deletions: 0,
    reviewDecision: null,
    updatedAt: "2026-10-05T00:00:00Z",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    statusCheckRollup: [],
    ...overrides,
  };
}

describe("prReviewers", () => {
  it("returns nothing for a PR with no requests or reviews", () => {
    expect(prReviewers(pr({}))).toEqual([]);
  });

  it("lists requested people, bots and teams alongside submitted reviews, approvals first", () => {
    const reviewers = prReviewers(
      pr({
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: "User", login: "zed" } },
            { requestedReviewer: { __typename: "Bot", login: "copilot" } },
            {
              requestedReviewer: {
                __typename: "Team",
                slug: "core",
                organization: { login: "acme" },
              },
            },
          ],
        },
        latestReviews: {
          nodes: [
            { author: { __typename: "User", login: "carol" }, state: "CHANGES_REQUESTED" },
            { author: { __typename: "User", login: "bob" }, state: "APPROVED" },
            { author: { __typename: "User", login: "alice" }, state: "APPROVED" },
            { author: { __typename: "User", login: "dan" }, state: "COMMENTED" },
          ],
        },
      }),
    );
    expect(reviewers).toEqual([
      { name: "alice", state: "approved" },
      { name: "bob", state: "approved" },
      { name: "carol", state: "changes-requested" },
      { name: "acme/core", state: "requested", isTeam: true },
      { name: "copilot", state: "requested", isBot: true },
      { name: "zed", state: "requested" },
      { name: "dan", state: "commented" },
    ]);
  });

  it("treats a re-requested reviewer as waiting again", () => {
    const reviewers = prReviewers(
      pr({
        reviewRequests: {
          nodes: [{ requestedReviewer: { __typename: "User", login: "Bob" } }],
        },
        latestReviews: {
          nodes: [{ author: { login: "bob" }, state: "CHANGES_REQUESTED" }],
        },
      }),
    );
    expect(reviewers).toEqual([{ name: "Bob", state: "requested" }]);
  });

  it("drops dismissed and unsubmitted reviews and ghost authors", () => {
    const reviewers = prReviewers(
      pr({
        latestReviews: {
          nodes: [
            { author: { login: "a" }, state: "DISMISSED" },
            { author: { login: "b" }, state: "PENDING" },
            { author: null, state: "APPROVED" },
          ],
        },
      }),
    );
    expect(reviewers).toEqual([]);
  });
});
