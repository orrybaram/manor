import { describe, it, expect } from "vitest";
import {
  collectTasks,
  filterTasks,
  fromGitHub,
  fromLinear,
  initialOf,
  pageWindow,
  paginate,
  relativeTime,
  sortTasks,
  trackerHomeUrl,
  withoutLinkedTasks,
  type TaskContext,
  type TaskRow,
} from "./tasks";
import type { GitHubIssue, LinearIssue } from "../electron.d";
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

describe("fromGitHub", () => {
  it("normalises a gh list result", () => {
    const r = fromGitHub(gh(), ctx);
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
    const r = fromGitHub(
      gh({ state: "CLOSED", labels: [{ name: "x", color: "nope" }] }),
      ctx,
    );
    expect(r.status).toEqual({ label: "Closed", tone: "closed" });
    expect(r.labels).toEqual([{ name: "x", color: undefined }]);
  });
});

describe("fromLinear", () => {
  it("normalises a Linear list result", () => {
    const r = fromLinear(linear(), ctx);
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

  it("tints by state type and handles no assignee", () => {
    expect(
      fromLinear(linear({ state: { name: "Backlog", type: "backlog" } }), ctx)
        .status.tone,
    ).toBe("backlog");
    expect(
      fromLinear(linear({ state: { name: "Todo", type: "unstarted" } }), ctx)
        .status.tone,
    ).toBe("todo");
    expect(
      fromLinear(linear({ state: { name: "Done", type: "completed" } }), ctx)
        .status.tone,
    ).toBe("closed");
    expect(fromLinear(linear({ assignee: null }), ctx).assignees).toEqual([]);
    expect(
      fromLinear(linear({ assignee: { name: "Carol" } }), ctx).assignees,
    ).toEqual(["Carol"]);
  });
});

describe("sortTasks / collectTasks", () => {
  it("sorts by updatedAt desc, undated last, stable on ties", () => {
    const a = row({ key: "a", updatedAt: "2026-01-01T00:00:00Z" });
    const b = row({ key: "b", updatedAt: "2026-03-01T00:00:00Z" });
    const c = row({ key: "c", updatedAt: "" });
    const d = row({ key: "d", updatedAt: "2026-03-01T00:00:00Z" });
    expect(sortTasks([a, c, b, d]).map((r) => r.key)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });

  it("drops duplicate tasks by provider + url", () => {
    const a = row({ key: "a", url: "u1" });
    const b = row({ key: "b", url: "u1" });
    const c = row({ key: "c", url: "u1", provider: "linear" });
    expect(collectTasks([a, b, c]).map((r) => r.key)).toEqual(["a", "c"]);
  });
});

describe("filterTasks", () => {
  const rows = [
    row({ key: "1", title: "Fix Login", displayId: "#1", labels: [] }),
    row({ key: "2", title: "Other", displayId: "ENG-45", labels: [] }),
    row({
      key: "3",
      title: "Third",
      displayId: "#3",
      labels: [{ name: "Bug" }],
    }),
  ];

  it("matches title, id and labels case-insensitively", () => {
    expect(filterTasks(rows, "login").map((r) => r.key)).toEqual(["1"]);
    expect(filterTasks(rows, "eng-4").map((r) => r.key)).toEqual(["2"]);
    expect(filterTasks(rows, "BUG").map((r) => r.key)).toEqual(["3"]);
  });

  it("returns every row for a blank query", () => {
    expect(filterTasks(rows, "  ")).toHaveLength(3);
  });
});

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

describe("trackerHomeUrl", () => {
  it("derives the repo issues page and the Linear team page", () => {
    const rows = [fromGitHub(gh(), ctx), fromLinear(linear(), ctx)];
    expect(trackerHomeUrl(rows, "github")).toBe(
      "https://github.com/acme/manor/issues",
    );
    expect(trackerHomeUrl(rows, "linear")).toBe(
      "https://linear.app/acme/team/ENG/all",
    );
    expect(trackerHomeUrl([], "github")).toBeNull();
  });
});

describe("withoutLinkedTasks", () => {
  const ghRow = fromGitHub(gh(), ctx);
  const otherRepoRow = fromGitHub(
    gh({ url: "https://github.com/acme/other/issues/12" }),
    ctx,
  );
  const linearRow = fromLinear(linear(), ctx);
  const withLinks = (linkedIssues: { id: string; url: string }[]) =>
    [
      {
        workspaces: [
          {
            linkedIssues: linkedIssues.map((l) => ({
              ...l,
              identifier: "",
              title: "",
            })),
          },
        ],
      },
    ] as unknown as ProjectInfo[];

  it("keeps everything when nothing is linked", () => {
    expect(withoutLinkedTasks([ghRow, linearRow], withLinks([]))).toEqual([
      ghRow,
      linearRow,
    ]);
  });

  it("hides a GitHub task linked by URL, not a same-numbered one in another repo", () => {
    const links = withLinks([
      { id: "gh-12", url: "https://github.com/acme/manor/issues/12/" },
    ]);
    expect(withoutLinkedTasks([ghRow, otherRepoRow], links)).toEqual([
      otherRepoRow,
    ]);
  });

  it("hides a Linear task linked by id even when the URL differs", () => {
    const links = withLinks([
      { id: "lin-1", url: "https://linear.app/acme/issue/ENG-45" },
    ]);
    expect(withoutLinkedTasks([ghRow, linearRow], links)).toEqual([ghRow]);
  });
});
