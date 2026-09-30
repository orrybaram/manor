import { describe, it, expect } from "vitest";
import {
  applyTaskFilters,
  DEFAULT_TASK_SORT,
  facetLabel,
  facetOptions,
  fieldsFor,
  filterableFields,
  NONE_VALUE,
  ME_VALUE,
  DEFAULT_TASK_FILTERS,
  sortableFields,
  sortTasksBy,
  TASK_FIELDS,
  type TaskFieldId,
  type TaskSort,
  initialOf,
  pageWindow,
  paginate,
  relativeTime,
  type TaskContext,
  type TaskRow,
} from "./tasks";
import type { GitHubIssue, LinearIssue } from "../electron.d";
import { toRow as fromGitHub } from "./trackers/github";
import { toRow as fromLinear } from "./trackers/linear";
import type { ProjectInfo } from "../store/project-store";

const project = { id: "p1", name: "manor", color: "blue" } as ProjectInfo;
const ctx: TaskContext = {
  entryKey: "p1",
  project,
  projectName: "manor",
  color: "blue",
};

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

function row(over: Partial<TaskRow>): TaskRow {
  return { ...fromGitHub(gh(), ctx), ...over };
}

describe("paginate", () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ key: String(i) }));

  it("slices 25 per page", () => {
    const p = paginate(rows, 2);
    expect(p.pageCount).toBe(3);
    expect(p.page).toBe(2);
    expect(p.rows.map((r) => r.key)[0]).toBe("25");
    expect(p.rows).toHaveLength(25);
    expect(paginate(rows, 3).rows).toHaveLength(10);
  });

  it("clamps out-of-range pages and keeps one page when empty", () => {
    expect(paginate(rows, 9).page).toBe(3);
    expect(paginate(rows, 0).page).toBe(1);
    expect(paginate([], 1)).toEqual({ rows: [], page: 1, pageCount: 1 });
  });

  it("honours a custom size", () => {
    expect(paginate(rows, 1, 10).pageCount).toBe(6);
  });
});

describe("pageWindow", () => {
  it("shows every page when there are few", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  it("elides runs with gaps", () => {
    expect(pageWindow(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageWindow(1, 10)).toEqual([1, 2, "gap", 10]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");

  it("formats elapsed time", () => {
    expect(relativeTime("2026-09-29T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-09-29T11:59:00Z", now)).toBe("1 minute ago");
    expect(relativeTime("2026-09-29T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-09-26T12:00:00Z", now)).toBe("3 days ago");
    expect(relativeTime("2026-07-29T12:00:00Z", now)).toBe("2 months ago");
    expect(relativeTime("2025-09-01T12:00:00Z", now)).toBe("1 year ago");
  });

  it("clamps future times and ignores garbage", () => {
    expect(relativeTime("2026-09-30T00:00:00Z", now)).toBe("just now");
    expect(relativeTime("", now)).toBe("");
  });
});

describe("initialOf", () => {
  it("uppercases the first letter", () => {
    expect(initialOf("alice")).toBe("A");
    expect(initialOf(" ")).toBe("?");
  });
});

describe("task fields", () => {
  it("lists the fields per provider, split into filterable and sortable", () => {
    expect(fieldsFor("github")).toEqual([
      "progress",
      "status",
      "assignee",
      "author",
      "label",
      "trackerProject",
      "milestone",
      "project",
      "id",
      "title",
      "updated",
      "created",
      "comments",
    ]);
    expect(fieldsFor("linear")).toEqual([
      "progress",
      "status",
      "priority",
      "assignee",
      "author",
      "label",
      "trackerProject",
      "cycle",
      "team",
      "project",
      "id",
      "title",
      "updated",
      "created",
      "dueDate",
      "estimate",
    ]);
    expect(filterableFields("linear")).toEqual([
      "progress",
      "status",
      "priority",
      "assignee",
      "author",
      "label",
      "trackerProject",
      "cycle",
      "team",
      "project",
    ]);
    expect(filterableFields("github")).toContain("milestone");
    expect(sortableFields("github")).not.toContain("label");
    expect(sortableFields("github")).toEqual(
      expect.arrayContaining(["id", "title", "updated", "created", "comments"]),
    );
    expect(sortableFields("linear")).toEqual(
      expect.arrayContaining(["priority", "dueDate", "estimate", "cycle"]),
    );
  });

  it("offers Me as the first assignee and filters on it", () => {
    const mine = {
      ...fromLinear(linear({ id: "a" }), ctx),
      assignedToMe: true,
    };
    const theirs = fromLinear(linear({ id: "b" }), ctx);
    expect(facetOptions([theirs, mine], "assignee")[0]).toEqual({
      value: ME_VALUE,
      count: 1,
    });
    expect(facetLabel("assignee", ME_VALUE)).toBe("Me");
    expect(applyTaskFilters([theirs, mine], { assignee: [ME_VALUE] })).toEqual([
      mine,
    ]);
  });

  it("splits tasks by progress, defaulting to yours not started", () => {
    const fresh = {
      ...fromLinear(linear({ id: "a" }), ctx),
      assignedToMe: true,
    };
    const started = { ...fresh, key: "started", inProgress: true };
    const other = fromLinear(linear({ id: "b" }), ctx);
    expect(
      facetOptions([started, fresh], "progress").map((o) => o.value),
    ).toEqual(["not-started", "in-progress"]);
    expect(facetLabel("progress", "in-progress")).toBe("In progress");
    expect(
      applyTaskFilters([fresh, started, other], DEFAULT_TASK_FILTERS),
    ).toEqual([fresh]);
  });

  it("reads each field's facet values, [] when the row has none", () => {
    const full = fromLinear(
      linear({
        priority: 1,
        priorityLabel: "Urgent",
        project: { name: "Launch" },
        cycle: { number: 4, name: null },
        team: { key: "ENG", name: "Engineering" },
        creator: { name: "Dana" },
      }),
      ctx,
    );
    const facet = (id: TaskFieldId, r: TaskRow) => TASK_FIELDS[id].facet!(r);
    expect(facet("status", full)).toEqual(["In Progress"]);
    expect(facet("priority", full)).toEqual(["1"]);
    expect(facet("assignee", full)).toEqual(["alice"]);
    expect(facet("author", full)).toEqual(["Dana"]);
    expect(facet("label", full)).toEqual(["Feature"]);
    expect(facet("trackerProject", full)).toEqual(["Launch"]);
    expect(facet("cycle", full)).toEqual(["Cycle 4"]);
    expect(facet("team", full)).toEqual(["ENG"]);
    expect(facet("project", full)).toEqual(["manor"]);

    const bare = fromLinear(
      linear({ priority: 0, assignee: null, labels: [] }),
      ctx,
    );
    for (const id of [
      "priority",
      "assignee",
      "author",
      "label",
      "trackerProject",
      "cycle",
      "team",
    ] as const) {
      expect(facet(id, bare)).toEqual([]);
    }

    const issue = fromGitHub(
      gh({ milestone: { title: "v1" }, projectItems: [{ title: "Roadmap" }] }),
      ctx,
    );
    expect(facet("milestone", issue)).toEqual(["v1"]);
    expect(facet("trackerProject", issue)).toEqual(["Roadmap"]);
    expect(facet("milestone", fromGitHub(gh(), ctx))).toEqual([]);
    expect(facet("status", fromGitHub(gh({ state: "CLOSED" }), ctx))).toEqual([
      "Closed",
    ]);
  });

  it("labels facet values", () => {
    expect(facetLabel("priority", NONE_VALUE)).toBe("No priority");
    expect(facetLabel("label", NONE_VALUE)).toBe("No label");
    expect(facetLabel("assignee", NONE_VALUE)).toBe("No assignee");
    expect(facetLabel("priority", "1")).toBe("Urgent");
    expect(facetLabel("priority", "4")).toBe("Low");
    expect(facetLabel("priority", "7")).toBe("P7");
    expect(facetLabel("team", "ENG")).toBe("ENG");
  });
});

describe("facetOptions", () => {
  it("counts values from the loaded rows, alphabetically, None last", () => {
    const rows = [
      row({ key: "1", labels: [{ name: "bug" }, { name: "ui" }] }),
      row({ key: "2", labels: [{ name: "Api" }, { name: "bug" }] }),
      row({ key: "3", labels: [] }),
      row({ key: "4", labels: [{ name: "bug" }, { name: "bug" }] }),
    ];
    expect(facetOptions(rows, "label")).toEqual([
      { value: "Api", count: 1 },
      { value: "bug", count: 3 },
      { value: "ui", count: 1 },
      { value: NONE_VALUE, count: 1 },
    ]);
  });

  it("omits None when every row has a value", () => {
    expect(facetOptions([row({ assignees: ["a"] })], "assignee")).toEqual([
      { value: "a", count: 1 },
    ]);
  });

  it("orders priority by urgency, not alphabetically", () => {
    const rows = [4, 0, 2, 1, 3, 2].map((value, i) =>
      row({ key: String(i), priority: { value, label: "" } }),
    );
    expect(facetOptions(rows, "priority")).toEqual([
      { value: "1", count: 1 },
      { value: "2", count: 2 },
      { value: "3", count: 1 },
      { value: "4", count: 1 },
      { value: NONE_VALUE, count: 1 },
    ]);
  });

  it("orders numerically within text and is empty for non-filterable fields", () => {
    const rows = ["Cycle 10", "Cycle 9"].map((cycle) => row({ cycle }));
    expect(facetOptions(rows, "cycle").map((o) => o.value)).toEqual([
      "Cycle 9",
      "Cycle 10",
    ]);
    expect(facetOptions(rows, "title")).toEqual([]);
  });
});

describe("applyTaskFilters", () => {
  const rows = [
    row({ key: "a", labels: [{ name: "bug" }], assignees: ["alice"] }),
    row({ key: "b", labels: [{ name: "ui" }], assignees: ["bob"] }),
    row({ key: "c", labels: [{ name: "bug" }, { name: "ui" }], assignees: [] }),
    row({ key: "d", labels: [], assignees: ["alice"] }),
  ];
  const keys = (filters: Parameters<typeof applyTaskFilters>[1]) =>
    applyTaskFilters(rows, filters).map((r) => r.key);

  it("matches any chosen value within a field", () => {
    expect(keys({ label: ["bug"] })).toEqual(["a", "c"]);
    expect(keys({ label: ["bug", "ui"] })).toEqual(["a", "b", "c"]);
  });

  it("requires every filtered field to match", () => {
    expect(keys({ label: ["bug"], assignee: ["alice"] })).toEqual(["a"]);
    expect(keys({ label: ["ui"], assignee: ["alice"] })).toEqual([]);
  });

  it("matches None to rows with no value, alongside real values", () => {
    expect(keys({ label: [NONE_VALUE] })).toEqual(["d"]);
    expect(keys({ assignee: [NONE_VALUE, "bob"] })).toEqual(["b", "c"]);
  });

  it("ignores empty lists and non-filterable fields", () => {
    expect(keys({})).toEqual(["a", "b", "c", "d"]);
    expect(keys({ label: [] })).toEqual(["a", "b", "c", "d"]);
    expect(keys({ title: ["nope"] })).toEqual(["a", "b", "c", "d"]);
  });
});

describe("sortTasksBy", () => {
  const order = (rows: TaskRow[], sort: TaskSort) =>
    sortTasksBy(rows, sort).map((r) => r.key);
  const asc = (field: TaskFieldId): TaskSort => ({ field, direction: "asc" });
  const desc = (field: TaskFieldId): TaskSort => ({ field, direction: "desc" });

  it("defaults to most recently updated first", () => {
    expect(DEFAULT_TASK_SORT).toEqual({ field: "updated", direction: "desc" });
    const rows = [
      row({ key: "a", updatedAt: "2026-01-01T00:00:00Z" }),
      row({ key: "b", updatedAt: "" }),
      row({ key: "c", updatedAt: "2026-03-01T00:00:00Z" }),
    ];
    expect(order(rows, DEFAULT_TASK_SORT)).toEqual(["c", "a", "b"]);
    expect(order(rows, asc("updated"))).toEqual(["a", "c", "b"]);
  });

  it("orders status by workflow tone, then label", () => {
    const tone = (key: string, label: string, t: TaskRow["status"]["tone"]) =>
      row({ key, status: { label, tone: t } });
    const rows = [
      tone("canceled", "Canceled", "canceled"),
      tone("closed", "Done", "closed"),
      tone("open", "Open", "open"),
      tone("started-b", "Review", "started"),
      tone("started-a", "In Progress", "started"),
      tone("backlog", "Backlog", "backlog"),
      tone("todo", "Todo", "todo"),
    ];
    expect(order(rows, asc("status"))).toEqual([
      "todo",
      "backlog",
      "started-a",
      "started-b",
      "open",
      "closed",
      "canceled",
    ]);
    expect(order(rows, desc("status"))[0]).toBe("canceled");
  });

  it("orders priority Urgent first, No priority last both ways", () => {
    const p = (key: string, value?: number) =>
      row({
        key,
        priority: value === undefined ? undefined : { value, label: "" },
      });
    const rows = [p("none", 0), p("low", 4), p("absent"), p("urgent", 1)];
    rows.push(p("high", 2));
    expect(order(rows, asc("priority"))).toEqual([
      "urgent",
      "high",
      "low",
      "none",
      "absent",
    ]);
    expect(order(rows, desc("priority"))).toEqual([
      "low",
      "high",
      "urgent",
      "none",
      "absent",
    ]);
  });

  it("orders IDs numerically", () => {
    const rows = ["#10", "#9", "#100"].map((displayId) =>
      row({ key: displayId, displayId }),
    );
    expect(order(rows, asc("id"))).toEqual(["#9", "#10", "#100"]);
    const lin = ["ENG-10", "ENG-9", "APP-2"].map((displayId) =>
      row({ key: displayId, displayId }),
    );
    expect(order(lin, asc("id"))).toEqual(["APP-2", "ENG-9", "ENG-10"]);
    expect(order(lin, desc("id"))).toEqual(["ENG-10", "ENG-9", "APP-2"]);
  });

  it("orders text fields case-insensitively with missing values last", () => {
    const rows = [
      row({ key: "b", title: "beta", assignees: ["Zed"], author: undefined }),
      row({ key: "a", title: "Alpha", assignees: [], author: "amy" }),
      row({ key: "c", title: "gamma", assignees: ["ann"], author: "Bob" }),
    ];
    expect(order(rows, asc("title"))).toEqual(["a", "b", "c"]);
    expect(order(rows, desc("title"))).toEqual(["c", "b", "a"]);
    expect(order(rows, asc("assignee"))).toEqual(["c", "b", "a"]);
    expect(order(rows, desc("assignee"))).toEqual(["b", "c", "a"]);
    expect(order(rows, asc("author"))).toEqual(["a", "c", "b"]);
    expect(order(rows, desc("author"))).toEqual(["c", "a", "b"]);
  });

  it("orders the remaining sortable fields, missing last", () => {
    const rows = [
      row({
        key: "x",
        trackerProjects: ["Beta"],
        milestone: "v2",
        cycle: "Cycle 10",
        team: "OPS",
        projectName: "zeta",
        createdAt: "2026-02-01T00:00:00Z",
        dueDate: "2026-12-01",
        estimate: 5,
        commentCount: 0,
      }),
      row({
        key: "y",
        trackerProjects: ["alpha"],
        milestone: "v10",
        cycle: "Cycle 9",
        team: "ENG",
        projectName: "alpha",
        createdAt: "2026-01-01T00:00:00Z",
        dueDate: "2026-10-01",
        estimate: 1,
        commentCount: 7,
      }),
      row({
        key: "z",
        trackerProjects: [],
        milestone: undefined,
        cycle: undefined,
        team: undefined,
        projectName: "",
        createdAt: "",
        dueDate: undefined,
        estimate: undefined,
        commentCount: undefined,
      }),
    ];
    const cases: [TaskFieldId, string[]][] = [
      ["trackerProject", ["y", "x", "z"]],
      ["milestone", ["x", "y", "z"]],
      ["cycle", ["y", "x", "z"]],
      ["team", ["y", "x", "z"]],
      ["project", ["y", "x", "z"]],
      ["created", ["y", "x", "z"]],
      ["dueDate", ["y", "x", "z"]],
      ["estimate", ["y", "x", "z"]],
      ["comments", ["x", "y", "z"]],
    ];
    for (const [field, ascending] of cases) {
      expect(order(rows, asc(field)), field).toEqual(ascending);
      expect(order(rows, desc(field)), field).toEqual([
        ascending[1],
        ascending[0],
        "z",
      ]);
    }
  });

  it("breaks ties by most recently updated, then input order", () => {
    const rows = [
      row({ key: "old", team: "ENG", updatedAt: "2026-01-01T00:00:00Z" }),
      row({ key: "first", team: "ENG", updatedAt: "2026-05-01T00:00:00Z" }),
      row({ key: "second", team: "ENG", updatedAt: "2026-05-01T00:00:00Z" }),
      row({ key: "ops", team: "OPS", updatedAt: "2026-09-01T00:00:00Z" }),
    ];
    expect(order(rows, asc("team"))).toEqual(["first", "second", "old", "ops"]);
    expect(order(rows, desc("team"))).toEqual([
      "ops",
      "first",
      "second",
      "old",
    ]);
  });

  it("exposes an ascending, missing-last compare per sortable field", () => {
    const a = row({ estimate: 2 });
    const b = row({ estimate: undefined });
    const compare = TASK_FIELDS.estimate.compare!;
    expect(compare(a, b)).toBeLessThan(0);
    expect(compare(b, a)).toBeGreaterThan(0);
    expect(compare(b, b)).toBe(0);
    expect(TASK_FIELDS.label.compare).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const rows = [row({ key: "b", title: "b" }), row({ key: "a", title: "a" })];
    sortTasksBy(rows, asc("title"));
    expect(rows.map((r) => r.key)).toEqual(["b", "a"]);
  });
});
