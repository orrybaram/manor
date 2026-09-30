import { describe, it, expect } from "vitest";
import { linearTracker, toRow } from "./linear";
import { toRow as githubRow } from "./github";
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

function linear(over: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: "lin-1",
    identifier: "ENG-45",
    title: "Ship it",
    url: "https://linear.app/acme/issue/ENG-45/ship-it",
    branchName: "eng-45-ship-it",
    priority: 2,
    state: { name: "In Progress", type: "started" },
    labels: [{ name: "Feature", color: "#5e6ad2" }],
    updatedAt: "2026-09-28T10:00:00Z",
    assignee: { name: "Alice Smith", displayName: "alice" },
    ...over,
  };
}

const ghRow = githubRow(
  {
    number: 12,
    title: "Fix the thing",
    url: "https://github.com/acme/manor/issues/12",
  } as GitHubIssue,
  ctx,
);

describe("toRow", () => {
  it("normalises a Linear list result", () => {
    const r = toRow(linear(), ctx);
    expect(r).toMatchObject({
      key: "linear:p1:lin-1",
      provider: "linear",
      displayId: "ENG-45",
      labels: [{ name: "Feature", color: "#5e6ad2" }],
      assignees: ["alice"],
      status: { label: "In Progress", tone: "started" },
    });
    expect(r.author).toBeUndefined();
  });

  it("carries priority, project, cycle, team, estimate, due date and creator", () => {
    const r = toRow(
      linear({
        priority: 1,
        priorityLabel: "Urgent",
        createdAt: "2026-09-01T00:00:00Z",
        dueDate: "2026-10-01",
        estimate: 3,
        project: { name: "Launch" },
        cycle: { number: 12, name: null },
        team: { key: "ENG", name: "Engineering" },
        creator: { name: "Dana D", displayName: "dana" },
      }),
      ctx,
    );
    expect(r).toMatchObject({
      priority: { value: 1, label: "Urgent" },
      trackerProjects: ["Launch"],
      cycle: "Cycle 12",
      team: "ENG",
      estimate: 3,
      dueDate: "2026-10-01",
      createdAt: "2026-09-01T00:00:00Z",
      author: "dana",
    });
  });

  it("prefers the cycle name, falls back to creator name, and defaults missing fields", () => {
    expect(
      toRow(linear({ cycle: { number: 3, name: "Sprint" } }), ctx).cycle,
    ).toBe("Sprint");
    expect(toRow(linear({ creator: { name: "Eve" } }), ctx).author).toBe(
      "Eve",
    );
    const r = toRow(linear({ priority: 0 }), ctx);
    expect(r.priority).toEqual({ value: 0, label: "No priority" });
    expect(r.trackerProjects).toEqual([]);
    expect(r.createdAt).toBe("");
    expect(r.cycle).toBeUndefined();
    expect(r.estimate).toBeUndefined();
  });

  it("tints by state type and handles no assignee", () => {
    expect(
      toRow(linear({ state: { name: "Backlog", type: "backlog" } }), ctx)
        .status.tone,
    ).toBe("backlog");
    expect(
      toRow(linear({ state: { name: "Todo", type: "unstarted" } }), ctx)
        .status.tone,
    ).toBe("todo");
    expect(
      toRow(linear({ state: { name: "Done", type: "completed" } }), ctx)
        .status.tone,
    ).toBe("closed");
    expect(toRow(linear({ assignee: null }), ctx).assignees).toEqual([]);
    expect(
      toRow(linear({ assignee: { name: "Carol" } }), ctx).assignees,
    ).toEqual(["Carol"]);
  });
});

describe("linearTracker.ownsLink", () => {
  it("owns every link that isn't a gh-N one", () => {
    expect(linearTracker.ownsLink(link({ id: "lin-1" }))).toBe(true);
    expect(linearTracker.ownsLink(link({ id: "gh-12" }))).toBe(false);
  });
});

describe("linearTracker.matchesLink", () => {
  const row = toRow(linear(), ctx);

  it("matches by issue id without a URL", () => {
    expect(linearTracker.matchesLink(link({ id: "lin-1" }), row)).toBe(true);
  });

  it("matches by URL, ignoring a trailing slash and case", () => {
    expect(
      linearTracker.matchesLink(
        link({
          id: "other",
          url: "https://linear.app/ACME/issue/ENG-45/ship-it/",
        }),
        row,
      ),
    ).toBe(true);
  });

  it("does not match another issue or a GitHub row", () => {
    expect(
      linearTracker.matchesLink(
        link({ id: "lin-2", url: "https://linear.app/acme/issue/ENG-46" }),
        row,
      ),
    ).toBe(false);
    expect(
      linearTracker.matchesLink(link({ id: "lin-1", url: ghRow.url }), ghRow),
    ).toBe(false);
  });
});

describe("linearTracker.homeUrl", () => {
  it("derives the team page from a Linear row", () => {
    expect(linearTracker.homeUrl([ghRow, toRow(linear(), ctx)])).toBe(
      "https://linear.app/acme/team/ENG/all",
    );
    expect(linearTracker.homeUrl([ghRow])).toBeNull();
    expect(linearTracker.homeUrl([])).toBeNull();
  });
});
