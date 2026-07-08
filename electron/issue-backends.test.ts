import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  availableSources,
  issueBackend,
  InvalidIssueRef,
} from "./issue-backends";
import type { IssueDeps, IssueProject } from "./issue-backends";
import type { GitHubManager, GitHubIssue, GitHubIssueDetail } from "./github";
import type { LinearManager, LinearIssue, LinearIssueDetail } from "./linear";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeGitHubIssue(number: number): GitHubIssue {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/demo/issues/${number}`,
    state: "open",
    labels: [{ name: "bug", color: "red" }],
  } as GitHubIssue;
}

function makeGitHubIssueDetail(number: number): GitHubIssueDetail {
  return {
    ...makeGitHubIssue(number),
    body: `Body for #${number}`,
    assignees: [{ login: "octocat" }],
  } as GitHubIssueDetail;
}

function makeLinearIssue(identifier: string): LinearIssue {
  return {
    id: `uuid-${identifier}`,
    identifier,
    title: `Linear issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    state: { name: "In Progress", type: "started" },
    labels: [{ name: "bug", color: "red" }],
  } as LinearIssue;
}

function makeLinearIssueDetail(identifier: string): LinearIssueDetail {
  return {
    ...makeLinearIssue(identifier),
    description: `Description for ${identifier}`,
    assignee: { displayName: "Ada" },
  } as LinearIssueDetail;
}

const PROJECT: IssueProject = {
  path: "/repos/demo",
  linearAssociations: [{ teamId: "team-1", teamName: "Eng", teamKey: "ENG" }],
};

const NO_TEAM: IssueProject = { ...PROJECT, linearAssociations: [] };

/** `deps` shaped like ControlDeps' relevant slice, with vi.fn() managers. */
function makeDeps() {
  const githubManager = {
    getMyIssues: vi.fn(async () => [makeGitHubIssue(1)]),
    getAllIssues: vi.fn(async () => [makeGitHubIssue(2)]),
    getIssueDetail: vi.fn(async () => makeGitHubIssueDetail(42)),
  };
  const linearManager = {
    isConnected: vi.fn(() => true),
    getMyIssues: vi.fn(async () => [makeLinearIssue("ENG-1")]),
    getAllIssues: vi.fn(async () => [makeLinearIssue("ENG-2")]),
    getIssueDetail: vi.fn(async () => makeLinearIssueDetail("ENG-1")),
  };
  const deps: IssueDeps = {
    githubManager: githubManager as unknown as GitHubManager,
    linearManager: linearManager as unknown as LinearManager,
  };
  return { deps, githubManager, linearManager };
}

/** Unwrap a backend, failing loudly if resolution did not succeed. */
function backendOf(...args: Parameters<typeof issueBackend>) {
  const result = issueBackend(...args);
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.backend;
}

// ─── github backend ─────────────────────────────────────────────────────────

describe("issueBackend('github')", () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it("503s with the exact message when no GitHub manager is configured", () => {
    const result = issueBackend(
      { ...ctx.deps, githubManager: null },
      PROJECT,
      "github",
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "GitHub is not available",
    });
  });

  it("list(assigned) calls getMyIssues with path, limit, state", async () => {
    const issues = await backendOf(ctx.deps, PROJECT, "github").list(
      "assigned",
      "open",
      50,
    );
    expect(ctx.githubManager.getMyIssues).toHaveBeenCalledWith(
      "/repos/demo",
      50,
      "open",
    );
    expect(ctx.githubManager.getAllIssues).not.toHaveBeenCalled();
    expect(issues).toEqual([
      {
        source: "github",
        id: "1",
        ref: "#1",
        title: "Issue 1",
        url: "https://github.com/acme/demo/issues/1",
        state: "open",
        labels: ["bug"],
      },
    ]);
  });

  it("list(all) calls getAllIssues, not getMyIssues", async () => {
    await backendOf(ctx.deps, PROJECT, "github").list("all", "closed", 10);
    expect(ctx.githubManager.getAllIssues).toHaveBeenCalledWith(
      "/repos/demo",
      10,
      "closed",
    );
    expect(ctx.githubManager.getMyIssues).not.toHaveBeenCalled();
  });

  it("detail() parses a numeric ref and normalizes the result", async () => {
    const detail = await backendOf(ctx.deps, PROJECT, "github").detail("42");
    expect(ctx.githubManager.getIssueDetail).toHaveBeenCalledWith(
      "/repos/demo",
      42,
    );
    expect(detail).toMatchObject({
      source: "github",
      id: "42",
      ref: "#42",
      body: "Body for #42",
      assignees: ["octocat"],
    });
  });

  it.each(["ENG-1", "", "abc", "0", "-3"])(
    "detail(%o) throws InvalidIssueRef and never calls getIssueDetail",
    async (ref) => {
      const backend = backendOf(ctx.deps, PROJECT, "github");
      await expect(backend.detail(ref)).rejects.toThrow(InvalidIssueRef);
      await expect(backend.detail(ref)).rejects.toThrow(
        "GitHub issue refs must be numeric.",
      );
      expect(ctx.githubManager.getIssueDetail).not.toHaveBeenCalled();
    },
  );

  it("InvalidIssueRef carries the bare sentence as its message", async () => {
    const backend = backendOf(ctx.deps, PROJECT, "github");
    const err = await backend.detail("nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIssueRef);
    expect((err as Error).message).toBe("GitHub issue refs must be numeric.");
  });

  it("propagates a manager throw so the route can map it to 502", async () => {
    ctx.githubManager.getAllIssues.mockRejectedValueOnce(
      new Error("gh exploded"),
    );
    await expect(
      backendOf(ctx.deps, PROJECT, "github").list("all", "open", 50),
    ).rejects.toThrow("gh exploded");
  });

  it("does not consult Linear readiness", () => {
    issueBackend(ctx.deps, NO_TEAM, "github");
    expect(ctx.linearManager.isConnected).not.toHaveBeenCalled();
  });
});

// ─── linear backend ─────────────────────────────────────────────────────────

describe("issueBackend('linear')", () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it("503s with the exact message when no Linear manager is configured", () => {
    const result = issueBackend(
      { ...ctx.deps, linearManager: null },
      PROJECT,
      "linear",
    );
    expect(result).toEqual({
      ok: false,
      status: 503,
      error: "Linear is not connected. Connect Linear in Manor settings.",
    });
  });

  it("503s when isConnected() is false", () => {
    ctx.linearManager.isConnected.mockReturnValue(false);
    expect(issueBackend(ctx.deps, PROJECT, "linear")).toEqual({
      ok: false,
      status: 503,
      error: "Linear is not connected. Connect Linear in Manor settings.",
    });
  });

  it("400s (not 503) when the project has no Linear team associated", () => {
    expect(issueBackend(ctx.deps, NO_TEAM, "linear")).toEqual({
      ok: false,
      status: 400,
      error: "Project has no Linear team associated.",
    });
  });

  it("a disconnected manager outranks a missing association", () => {
    ctx.linearManager.isConnected.mockReturnValue(false);
    const result = issueBackend(ctx.deps, NO_TEAM, "linear");
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("list(assigned) calls getMyIssues with team ids and open state types", async () => {
    const issues = await backendOf(ctx.deps, PROJECT, "linear").list(
      "assigned",
      "open",
      50,
    );
    expect(ctx.linearManager.getMyIssues).toHaveBeenCalledWith(["team-1"], {
      stateTypes: ["triage", "backlog", "unstarted", "started"],
      limit: 50,
    });
    expect(ctx.linearManager.getAllIssues).not.toHaveBeenCalled();
    expect(issues).toEqual([
      {
        source: "linear",
        id: "ENG-1",
        ref: "ENG-1",
        title: "Linear issue ENG-1",
        url: "https://linear.app/acme/issue/ENG-1",
        state: "In Progress",
        labels: ["bug"],
      },
    ]);
  });

  it("list(all) calls getAllIssues with the closed state types", async () => {
    await backendOf(ctx.deps, PROJECT, "linear").list("all", "closed", 10);
    expect(ctx.linearManager.getAllIssues).toHaveBeenCalledWith(["team-1"], {
      stateTypes: ["completed", "canceled"],
      limit: 10,
    });
    expect(ctx.linearManager.getMyIssues).not.toHaveBeenCalled();
  });

  it("passes every associated team id through", async () => {
    const project: IssueProject = {
      ...PROJECT,
      linearAssociations: [
        { teamId: "team-1", teamName: "Eng", teamKey: "ENG" },
        { teamId: "team-2", teamName: "Ops", teamKey: "OPS" },
      ],
    };
    await backendOf(ctx.deps, project, "linear").list("assigned", "all", 5);
    expect(ctx.linearManager.getMyIssues).toHaveBeenCalledWith(
      ["team-1", "team-2"],
      {
        stateTypes: [
          "triage",
          "backlog",
          "unstarted",
          "started",
          "completed",
          "canceled",
        ],
        limit: 5,
      },
    );
  });

  it("detail() forwards the ref verbatim — no numeric coercion", async () => {
    const detail = await backendOf(ctx.deps, PROJECT, "linear").detail("ENG-1");
    expect(ctx.linearManager.getIssueDetail).toHaveBeenCalledWith("ENG-1");
    expect(detail).toMatchObject({
      source: "linear",
      id: "ENG-1",
      ref: "ENG-1",
      body: "Description for ENG-1",
      assignees: ["Ada"],
    });
  });

  it("propagates a manager throw so the route can map it to 502", async () => {
    ctx.linearManager.getMyIssues.mockRejectedValueOnce(
      new Error("Linear API error: 401 Unauthorized"),
    );
    await expect(
      backendOf(ctx.deps, PROJECT, "linear").list("assigned", "open", 50),
    ).rejects.toThrow("401 Unauthorized");
  });
});

// ─── availableSources ───────────────────────────────────────────────────────

describe("availableSources", () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it("reports both when GitHub is present and Linear is connected + associated", () => {
    expect(availableSources(ctx.deps, PROJECT)).toEqual(["github", "linear"]);
  });

  it("omits linear when connected but the project has no association", () => {
    expect(availableSources(ctx.deps, NO_TEAM)).toEqual(["github"]);
  });

  it("omits linear when isConnected() is false", () => {
    ctx.linearManager.isConnected.mockReturnValue(false);
    expect(availableSources(ctx.deps, PROJECT)).toEqual(["github"]);
  });

  it("omits linear when there is no Linear manager at all", () => {
    expect(
      availableSources({ ...ctx.deps, linearManager: null }, PROJECT),
    ).toEqual(["github"]);
  });

  it("omits github when there is no GitHub manager", () => {
    expect(
      availableSources({ ...ctx.deps, githubManager: null }, PROJECT),
    ).toEqual(["linear"]);
  });

  it("reports nothing when neither source can serve", () => {
    expect(
      availableSources(
        { githubManager: null, linearManager: null },
        PROJECT,
      ),
    ).toEqual([]);
  });

  it("agrees with issueBackend: an advertised source always resolves", () => {
    for (const source of availableSources(ctx.deps, PROJECT)) {
      expect(issueBackend(ctx.deps, PROJECT, source).ok).toBe(true);
    }
  });

  it("agrees with issueBackend: an omitted linear never resolves", () => {
    expect(availableSources(ctx.deps, NO_TEAM)).not.toContain("linear");
    expect(issueBackend(ctx.deps, NO_TEAM, "linear").ok).toBe(false);
  });
});
