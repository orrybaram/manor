import { describe, it, expect } from "vitest";
import { githubTracker, toRow } from "./github";
import { toRow as linearRow } from "./linear";
import type { TaskContext } from "../tasks";
import type { GitHubIssue, LinearIssue } from "../../electron.d";
import type { LinkedIssue, ProjectInfo } from "../../store/project-store";

const project = { id: "p1", name: "manor", color: "blue" } as ProjectInfo;
const ctx: TaskContext = {
  entryKey: "p1",
  project,
  projectName: "manor",
  color: "blue",
};

function link(over: Partial<LinkedIssue> = {}): LinkedIssue {
  return { id: "", identifier: "", title: "", url: "", ...over };
}

function gh(over: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 12,
    title: "Fix the thing",
    url: "https://github.com/acme/manor/issues/12",
    state: "OPEN",
    labels: [{ name: "bug", color: "d73a4a" }],
    assignees: [{ login: "alice" }],
    updatedAt: "2026-09-29T10:00:00Z",
    author: { login: "bob" },
    ...over,
  };
}

describe("toRow", () => {
  it("normalises a gh list result", () => {
    const r = toRow(gh(), ctx);
    expect(r).toMatchObject({
      key: "github:p1:12",
      provider: "github",
      displayId: "#12",
      title: "Fix the thing",
      labels: [{ name: "bug", color: "#d73a4a" }],
      assignees: ["alice"],
      author: "bob",
      status: { label: "Open", tone: "open" },
      updatedAt: "2026-09-29T10:00:00Z",
      projectEntryKey: "p1",
      projectName: "manor",
      color: "blue",
    });
    expect(r.project).toBe(project);
    expect(r.raw).toEqual({ provider: "github", issue: gh() });
  });

  it("marks closed issues and drops unusable label colours", () => {
    const r = toRow(
      gh({ state: "CLOSED", labels: [{ name: "x", color: "nope" }] }),
      ctx,
    );
    expect(r.status).toEqual({ label: "Closed", tone: "closed" });
    expect(r.labels).toEqual([{ name: "x", color: undefined }]);
  });

  it("labels issues closed as not planned as canceled", () => {
    const r = toRow(
      gh({ state: "CLOSED", stateReason: "NOT_PLANNED" }),
      ctx,
    );
    expect(r.status).toEqual({
      label: "Closed (not planned)",
      tone: "canceled",
    });
    expect(
      toRow(gh({ state: "CLOSED", stateReason: "COMPLETED" }), ctx).status,
    ).toEqual({ label: "Closed", tone: "closed" });
  });

  it("carries milestone, projects, created date and comment count", () => {
    const r = toRow(
      gh({
        createdAt: "2026-09-01T00:00:00Z",
        milestone: { title: "v1" },
        commentCount: 4,
        projectItems: [{ title: "Roadmap", status: "Todo" }, { title: "Bugs" }],
      }),
      ctx,
    );
    expect(r).toMatchObject({
      createdAt: "2026-09-01T00:00:00Z",
      milestone: "v1",
      commentCount: 4,
      trackerProjects: ["Roadmap", "Bugs"],
    });
  });

  it("defaults the new fields when the tracker omits them", () => {
    const r = toRow(gh(), ctx);
    expect(r.createdAt).toBe("");
    expect(r.trackerProjects).toEqual([]);
    expect(r.milestone).toBeUndefined();
    expect(r.commentCount).toBeUndefined();
    expect(r.priority).toBeUndefined();
  });
});

describe("githubTracker.ownsLink", () => {
  it("owns gh-N links only", () => {
    expect(githubTracker.ownsLink(link({ id: "gh-12" }))).toBe(true);
    expect(githubTracker.ownsLink(link({ id: "lin-1" }))).toBe(false);
  });
});

describe("githubTracker.matchesLink", () => {
  const row = toRow(gh(), ctx);

  it("matches by URL, ignoring a trailing slash and case", () => {
    expect(
      githubTracker.matchesLink(
        link({ id: "gh-12", url: "https://GitHub.com/acme/Manor/issues/12/" }),
        row,
      ),
    ).toBe(true);
  });

  it("does not match the same number in another repo", () => {
    const other = toRow(
      gh({ url: "https://github.com/acme/other/issues/12" }),
      ctx,
    );
    const linked = link({
      id: "gh-12",
      url: "https://github.com/acme/manor/issues/12",
    });
    expect(githubTracker.matchesLink(linked, row)).toBe(true);
    expect(githubTracker.matchesLink(linked, other)).toBe(false);
  });

  it("does not match a link without a URL", () => {
    expect(githubTracker.matchesLink(link({ id: "gh-12" }), row)).toBe(false);
  });
});

describe("githubTracker.homeUrl", () => {
  it("derives the repo issues page from a GitHub row", () => {
    const linear = {
      id: "lin-1",
      identifier: "ENG-45",
      title: "Ship it",
      url: "https://linear.app/acme/issue/ENG-45/ship-it",
      branchName: "eng-45-ship-it",
    } as LinearIssue;
    expect(
      githubTracker.homeUrl([linearRow(linear, ctx), toRow(gh(), ctx)]),
    ).toBe("https://github.com/acme/manor/issues");
    expect(githubTracker.homeUrl([linearRow(linear, ctx)])).toBeNull();
    expect(githubTracker.homeUrl([])).toBeNull();
  });
});
