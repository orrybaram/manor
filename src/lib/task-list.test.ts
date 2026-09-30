import { describe, it, expect } from "vitest";
import {
  entryLookup,
  mergeSources,
  taskList,
  type TaskListPrefs,
} from "./task-list";
import {
  DEFAULT_TASK_FILTERS,
  DEFAULT_TASK_SORT,
  type LinkedTask,
  type TaskContext,
  type TaskRow,
} from "./tasks";
import { memoryTracker } from "./trackers/memory";
import { toRow as fromGitHub } from "./trackers/github";
import { toRow as fromLinear } from "./trackers/linear";
import type { GitHubIssue, LinearIssue } from "../electron.d";
import type { LinkedIssue, ProjectInfo } from "../store/project-store";

function project(
  id: string,
  name: string,
  links: { path: string; branch: string; linkedIssues: LinkedIssue[] }[],
): ProjectInfo {
  return {
    id,
    name,
    color: null,
    workspaces: links.map((ws) => ({ ...ws, isMain: false, name: null })),
  } as unknown as ProjectInfo;
}

const manor = project("p1", "manor", [
  {
    path: "/wt/fix",
    branch: "12-fix-the-thing",
    linkedIssues: [
      {
        id: "gh-12",
        identifier: "#12",
        title: "Old title",
        // Trailing slash: still the same task.
        url: "https://github.com/acme/manor/issues/12/",
      },
      {
        id: "lin-9",
        identifier: "ENG-9",
        title: "Linear thing",
        url: "https://linear.app/acme/issue/ENG-9",
      },
    ],
  },
]);
const other = project("p2", "other", [
  {
    path: "/wt/twenty",
    branch: "20-unlisted",
    linkedIssues: [
      {
        id: "gh-20",
        identifier: "#20",
        title: "Unlisted",
        url: "https://github.com/acme/other/issues/20",
      },
    ],
  },
]);
const projects = [manor, other];

function ctxOf(p: ProjectInfo): TaskContext {
  return { entryKey: p.id, project: p, projectName: p.name, color: null };
}

function gh(
  repo: string,
  number: number,
  title: string,
  updatedAt: string,
  labels: string[] = [],
): GitHubIssue {
  return {
    number,
    title,
    url: `https://github.com/acme/${repo}/issues/${number}`,
    state: "OPEN",
    labels: labels.map((name) => ({ name, color: "d73a4a" })),
    assignees: [{ login: "alice" }],
    updatedAt,
    author: { login: "bob" },
  };
}

function listed(
  issue: GitHubIssue,
  p: ProjectInfo,
  assignedToMe = false,
): TaskRow {
  return { ...fromGitHub(issue, ctxOf(p)), assignedToMe };
}

const issue12 = gh("manor", 12, "Fix the thing", "2026-09-29T10:00:00Z", [
  "bug",
]);
const issue13 = gh("manor", 13, "Add a button", "2026-09-28T10:00:00Z");
const issue14 = gh("manor", 14, "Only mine", "2026-09-27T10:00:00Z", [
  "feature",
]);
// Same number as the linked `gh-12`, but another repo.
const otherIssue12 = gh(
  "other",
  12,
  "Other repo's twelve",
  "2026-09-26T10:00:00Z",
);
const eng45 = fromLinear(
  {
    id: "lin-45",
    identifier: "ENG-45",
    title: "Ship it",
    url: "https://linear.app/acme/issue/ENG-45/ship-it",
    branchName: "eng-45-ship-it",
    priority: 2,
    state: { name: "Todo", type: "unstarted" },
    labels: [],
    updatedAt: "2026-09-25T10:00:00Z",
    assignee: null,
  } as LinearIssue,
  ctxOf(manor),
);

// Per-source results, in query order: p1 open / assigned, p2 open / assigned
// (failed), Linear p1 open. #13 is listed through both entries.
const merged = mergeSources([
  { rows: [listed(issue12, manor), listed(issue13, manor)], failed: false },
  {
    rows: [listed(issue12, manor, true), listed(issue14, manor, true)],
    failed: false,
  },
  {
    rows: [listed(issue13, other), listed(otherIssue12, other)],
    failed: false,
  },
  { rows: [], failed: true },
  { rows: [eng45], failed: false },
]);

const trackers = {
  github: memoryTracker("github", merged.rows),
  linear: memoryTracker("linear", merged.rows),
};

const input = { rows: merged.rows, projects, entryOf: entryLookup(projects) };

const CLEARED: TaskListPrefs = {
  provider: "github",
  projectKey: null,
  filters: {},
  sort: DEFAULT_TASK_SORT,
};

function list(over: Partial<TaskListPrefs> = {}) {
  return taskList(input, { ...CLEARED, ...over }, trackers);
}

const ids = (rows: readonly (TaskRow | LinkedTask)[]) =>
  rows.map((r) => `${r.displayId}@${r.projectEntryKey}`);

describe("mergeSources", () => {
  it("marks a task the assigned query listed, even where the open query listed it first", () => {
    const [first] = merged.rows;
    expect(first.displayId).toBe("#12");
    expect(first.assignedToMe).toBe(true);
    expect(merged.rows.find((r) => r.displayId === "#14")?.assignedToMe).toBe(
      true,
    );
  });

  it("drops repeats of a task, keeping the first, sorted by last update", () => {
    expect(ids(merged.rows)).toEqual([
      "#12@p1",
      "#13@p1",
      "#14@p1",
      "#12@p2",
      "ENG-45@p1",
    ]);
  });

  it("counts failed sources", () => {
    expect(merged.failedCount).toBe(1);
    expect(mergeSources([]).failedCount).toBe(0);
  });
});

describe("taskList", () => {
  it("lists a linked task once, as its linked row, and keeps a same-numbered task from another repo", () => {
    expect(ids(list().listed)).toEqual([
      "#13@p1",
      "#14@p1",
      "#12@p2",
      "#12@p1",
      "#20@p2",
    ]);
    const [, , , linked12] = list().listed;
    expect("workspacePath" in linked12).toBe(true);
  });

  it("fills a linked row from the fetched task, else falls back", () => {
    const rows = list().listed.filter(
      (r): r is LinkedTask => "workspacePath" in r,
    );
    const [linked12, linked20] = rows;
    expect(linked12).toMatchObject({
      provider: "github",
      title: "Fix the thing",
      labels: [{ name: "bug" }],
      assignees: ["alice"],
      updatedAt: "2026-09-29T10:00:00Z",
      inProgress: true,
      assignedToMe: true,
      projectId: "p1",
      workspacePath: "/wt/fix",
      workspaceName: "12-fix-the-thing",
    });
    expect(linked20).toMatchObject({
      title: "Unlisted",
      labels: [],
      status: { label: "In progress", tone: "started" },
      inProgress: true,
      assignedToMe: true,
      projectEntryKey: "p2",
    });
  });

  it("scopes fetched and linked rows to the provider and project", () => {
    expect(ids(list({ projectKey: "p1" }).listed)).toEqual([
      "#13@p1",
      "#14@p1",
      "#12@p1",
    ]);
    expect(ids(list({ projectKey: "p2" }).listed)).toEqual([
      "#12@p2",
      "#20@p2",
    ]);
    expect(ids(list({ provider: "linear" }).listed)).toEqual([
      "ENG-45@p1",
      "ENG-9@p1",
    ]);
    expect(ids(list({ provider: "linear", projectKey: "p2" }).listed)).toEqual(
      [],
    );
  });

  it("filters linked rows like any other", () => {
    expect(
      ids(list({ filters: { progress: ["in-progress"] } }).matching),
    ).toEqual(["#12@p1", "#20@p2"]);
    expect(ids(list({ filters: DEFAULT_TASK_FILTERS }).matching)).toEqual([
      "#14@p1",
    ]);
  });

  it("searches title, ID and labels after filtering", () => {
    const l = list({
      filters: { progress: ["not-started"] },
      search: "  FEATURE ",
    });
    expect(l.filtered).toHaveLength(3);
    expect(ids(l.matching)).toEqual(["#14@p1"]);
    expect(ids(list({ search: "#20" }).matching)).toEqual(["#20@p2"]);
    expect(ids(list({ search: "fix" }).matching)).toEqual(["#12@p1"]);
  });

  it("sorts the matching rows", () => {
    expect(
      ids(list({ sort: { field: "title", direction: "asc" } }).matching),
    ).toEqual(["#13@p1", "#12@p1", "#14@p1", "#12@p2", "#20@p2"]);
  });

  it("pages the matching rows", () => {
    const l = list();
    expect(l.page(2, 2)).toEqual({
      rows: l.matching.slice(2, 4),
      page: 2,
      pageCount: 3,
    });
    expect(l.page(1).pageCount).toBe(1);
  });

  it.each<[string, Partial<TaskListPrefs>]>([
    ["default filters", { filters: DEFAULT_TASK_FILTERS }],
    ["cleared filters", {}],
    ["a sort", { sort: { field: "title", direction: "desc" } }],
    ["a search", { search: "a" }],
    ["one project", { projectKey: "p1" }],
    ["Linear", { provider: "linear" }],
  ])("Up next (top) is a prefix of the Tasks page — %s", (_, over) => {
    const l = list(over);
    expect(l.matching.length).toBeGreaterThan(0);
    expect(l.top(5)).toEqual(l.page(1).rows.slice(0, 5));
    expect(l.top(5)).toEqual(l.matching.slice(0, 5));
    expect(l.top(2)).toEqual(l.page(1, 2).rows);
  });
});
