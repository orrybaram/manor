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

  // `list()` emits "#42"; ADR-148 promised that ref feeds straight back in.
  it.each(["42", "#42"])(
    "detail(%o) resolves issue 42 — the listing's ref round-trips",
    async (ref) => {
      const detail = await backendOf(ctx.deps, PROJECT, "github").detail(ref);
      expect(ctx.githubManager.getIssueDetail).toHaveBeenCalledWith(
        "/repos/demo",
        42,
      );
      expect(detail).toMatchObject({
        source: "github",
        ref: "#42",
        body: "Body for #42",
        assignees: ["octocat"],
      });
    },
  );

  it.each(["ENG-1", "", "abc", "0", "-3", "#", "42abc", "#42abc", " 42", "4 2"])(
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

  // `Number.parseInt("42abc", 10)` is 42, so the old predicate silently fetched
  // issue 42 for a ref the caller never meant.
  it("detail('42abc') does not silently fetch issue 42", async () => {
    await expect(
      backendOf(ctx.deps, PROJECT, "github").detail("42abc"),
    ).rejects.toThrow(InvalidIssueRef);
    expect(ctx.githubManager.getIssueDetail).not.toHaveBeenCalled();
  });

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
      ref: "ENG-1",
      body: "Description for ENG-1",
      assignees: ["Ada"],
    });
  });

  // Linear's `issue(id:)` resolves both, so validation must accept both.
  it.each([
    "ENG-1",
    "ENG-123",
    "A-1",
    "ENG2-9",
    "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "3FA85F64-5717-4562-B3FC-2C963F66AFA6",
  ])("detail(%o) passes validation and reaches the SDK", async (ref) => {
    await backendOf(ctx.deps, PROJECT, "linear").detail(ref);
    expect(ctx.linearManager.getIssueDetail).toHaveBeenCalledWith(ref);
  });

  // Previously the SDK threw on these and the route called it a 502 — the same
  // caller mistake GitHub answers with a 400.
  it.each(["nonsense", "", "42", "#42", "ENG-", "-1", "not-a-uuid"])(
    "detail(%o) throws InvalidIssueRef (→400) rather than an SDK error (→502)",
    async (ref) => {
      const backend = backendOf(ctx.deps, PROJECT, "linear");
      await expect(backend.detail(ref)).rejects.toThrow(InvalidIssueRef);
      await expect(backend.detail(ref)).rejects.toThrow(
        "Linear issue refs must be an identifier like 'ENG-123' or a UUID.",
      );
      expect(ctx.linearManager.getIssueDetail).not.toHaveBeenCalled();
    },
  );

  // Linear's resolver accepts `eng-1`; validation here must not be stricter than
  // the upstream it guards, or a model that lowercases a ref gets told its input
  // is malformed about something Linear would have served.
  it.each([
    ["eng-1", "ENG-1"],
    ["Eng-123", "ENG-123"],
  ])("detail(%o) is accepted and forwarded as %o", async (ref, forwarded) => {
    await backendOf(ctx.deps, PROJECT, "linear").detail(ref);
    expect(ctx.linearManager.getIssueDetail).toHaveBeenCalledWith(forwarded);
  });

  it("a malformed ref never becomes an SDK throw", async () => {
    ctx.linearManager.getIssueDetail.mockRejectedValue(
      new Error("Linear API error: Entity not found"),
    );
    const err = await backendOf(ctx.deps, PROJECT, "linear")
      .detail("nonsense")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidIssueRef);
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

// ─── ref round-trip ─────────────────────────────────────────────────────────

/**
 * The property ADR-148 claimed and never had: whatever `ref` a listing prints
 * is a ref `detail()` accepts. `list_issues` shows the model nothing else.
 */
describe("ref round-trip: list() → detail()", () => {
  let ctx: ReturnType<typeof makeDeps>;
  beforeEach(() => {
    ctx = makeDeps();
  });

  it("github: detail() accepts the '#42'-style ref list() emitted", async () => {
    const backend = backendOf(ctx.deps, PROJECT, "github");
    const [issue] = await backend.list("assigned", "open", 50);
    expect(issue.ref).toBe("#1");

    ctx.githubManager.getIssueDetail.mockResolvedValueOnce(
      makeGitHubIssueDetail(1),
    );
    const detail = await backend.detail(issue.ref);
    expect(ctx.githubManager.getIssueDetail).toHaveBeenCalledWith(
      "/repos/demo",
      1,
    );
    expect(detail.ref).toBe(issue.ref);
  });

  it("linear: detail() accepts the identifier list() emitted", async () => {
    const backend = backendOf(ctx.deps, PROJECT, "linear");
    const [issue] = await backend.list("assigned", "open", 50);
    expect(issue.ref).toBe("ENG-1");

    const detail = await backend.detail(issue.ref);
    expect(ctx.linearManager.getIssueDetail).toHaveBeenCalledWith("ENG-1");
    expect(detail.ref).toBe(issue.ref);
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
