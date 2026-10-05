import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Strategy:
// electron/github.ts does `const execFileAsync = promisify(execFile)` at
// module load time. Node's built-in execFile has util.promisify.custom so
// promisify resolves with { stdout, stderr }. Our mock needs the same symbol.
//
// We use vi.hoisted() to create a stable reference available at hoist time,
// then attach promisify.custom to it so the module sees the right behaviour.
// ---------------------------------------------------------------------------

const { mockState } = vi.hoisted(() => {
  return {
    mockState: {
      queue: [] as Array<{
        stdout?: string;
        stderr?: string;
        error?: Error & { stdout?: string; stderr?: string; code?: string };
      }>,
      /** Args of every execFile call since the last `setupExecFileCalls`. */
      calls: [] as string[][],
      /** The `cwd` option of each call in `calls`. */
      cwds: [] as Array<string | undefined>,
      /** The `env` option of each call in `calls`. */
      envs: [] as Array<Record<string, string | undefined> | undefined>,
    },
  };
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");

  type ExecFileCb = (err: Error | null, stdout: string, stderr: string) => void;

  // The callback-based execFile mock — consumed by the promisify.custom below
  function execFile(
    _cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string | undefined> },
    cb: ExecFileCb,
  ): void {
    mockState.calls.push(args);
    mockState.cwds.push(opts?.cwd);
    mockState.envs.push(opts?.env);
    const spec = mockState.queue.shift();
    if (!spec) {
      cb(new Error("unexpected execFile call — queue exhausted"), "", "");
      return;
    }
    if (spec.error) {
      cb(spec.error, spec.stdout ?? "", spec.stderr ?? "");
    } else {
      cb(null, spec.stdout ?? "", spec.stderr ?? "");
    }
  }

  // Attach promisify.custom so that promisify(execFile) resolves with
  // { stdout, stderr } instead of just stdout.
  Object.defineProperty(execFile, promisify.custom, {
    enumerable: false,
    value: (
      cmd: string,
      args: string[],
      opts: object,
    ): Promise<{ stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        execFile(cmd, args, opts, (err, stdout, stderr) => {
          if (err) {
            Object.assign(err, { stdout, stderr });
            reject(err);
          } else {
            resolve({ stdout, stderr });
          }
        });
      }),
  });

  return { execFile };
});

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/manor-feedback-test"),
}));

// Import AFTER mocks
import { GitHubManager, ghRepoFromRemoteUrl } from "./github";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallSpec = {
  stdout?: string;
  stderr?: string;
  error?: Error & { stdout?: string; stderr?: string; code?: string };
};

function setupExecFileCalls(calls: CallSpec[]) {
  mockState.queue = [...calls];
  mockState.calls = [];
  mockState.cwds = [];
  mockState.envs = [];
}

function success(stdout: string, stderr = ""): CallSpec {
  return { stdout, stderr };
}

function failure(
  message: string,
  extra: { stderr?: string; stdout?: string; code?: string } = {},
): CallSpec {
  const err = Object.assign(new Error(message), extra) as CallSpec["error"];
  return {
    error: err,
    stdout: extra.stdout ?? "",
    stderr: extra.stderr ?? "",
  };
}

/** A checkout on this machine. */
const REPO = { path: "/repo", hostId: "local" };

/** A `pullRequests` node of the batched branch query. */
function pr(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    state: "OPEN",
    title: `PR ${number}`,
    url: `https://github.com/owner/repo/pull/${number}`,
    isDraft: false,
    additions: 0,
    deletions: 0,
    reviewDecision: null,
    updatedAt: "2026-09-06T10:00:00Z",
    mergeable: "MERGEABLE",
    autoMergeRequest: null,
    ...rollup(),
    ...over,
  };
}

/** A PR node's `commits` carrying `contexts` as its last commit's rollup. */
function rollup(...contexts: Array<Record<string, unknown>>) {
  return {
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: contexts } } } }] },
  };
}

/** The batched branch query's answer: branch `i`'s PR, or none for null. */
function prsAnswer(...prs: Array<Record<string, unknown> | null>): string {
  const repository: Record<string, unknown> = {};
  prs.forEach((node, i) => {
    repository[`b${i}`] = { nodes: node ? [node] : [] };
  });
  return JSON.stringify({ data: { repository } });
}

/** The batched conversation query's answer, one pull request per PR asked. */
function conversation(...pulls: Array<Record<string, unknown>>): string {
  const r0: Record<string, unknown> = {};
  pulls.forEach((pull, i) => {
    r0[`p${i}`] = pull;
  });
  return JSON.stringify({ data: { viewer: { login: "me" }, r0 } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GitHubManager", () => {
  let manager: GitHubManager;

  beforeEach(() => {
    manager = new GitHubManager();
    mockState.queue = [];
  });

  // -------------------------------------------------------------------------
  // getPrForBranch / getPrsForBranches (#303: one query per repo)
  // -------------------------------------------------------------------------
  describe("getPrForBranch", () => {
    it("returns PR info from the batched query and its conversation", async () => {
      setupExecFileCalls([
        success(
          prsAnswer(
            pr(42, {
              title: "My PR",
              additions: 10,
              deletions: 2,
              reviewDecision: "APPROVED",
              ...rollup({ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }, { conclusion: "FAILURE" }),
            }),
          ),
        ),
        success(conversation({ reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] } })),
      ]);

      const result = await manager.getPrForBranch(REPO, "feat/my-branch");

      expect(result).not.toBeNull();
      expect(result!.number).toBe(42);
      expect(result!.state).toBe("open");
      expect(result!.title).toBe("My PR");
      expect(result!.checks).toEqual({
        total: 3,
        passing: 2,
        failing: 1,
        pending: 0,
        skipped: 0,
      });
      expect(result!.unresolvedThreads).toBe(1);
      expect(result!.reviewDecision).toBe("APPROVED");
      expect(result!.queuedToMerge).toBe(false);
      // The branch goes in as a variable; the repo comes from the checkout.
      expect(mockState.calls[0].slice(0, 2)).toEqual(["api", "graphql"]);
      expect(mockState.calls[0]).toEqual(
        expect.arrayContaining(["owner={owner}", "name={repo}", "h0=feat/my-branch"]),
      );
      expect(mockState.cwds[0]).toBe("/repo");
    });

    it("names each check run, with its workflow, and each status context", async () => {
      setupExecFileCalls([
        success(
          prsAnswer(
            pr(1, rollup(
              {
                __typename: "CheckRun",
                name: "test",
                conclusion: "FAILURE",
                detailsUrl: "https://ci/1",
                checkSuite: { workflowRun: { workflow: { name: "CI" } } },
              },
              { __typename: "StatusContext", context: "deploy", state: "PENDING", targetUrl: "https://d" },
            )),
          ),
        ),
        success(conversation({})),
      ]);

      const result = await manager.getPrForBranch(REPO, "b");
      expect(result!.checkRuns).toEqual([
        { name: "test", status: "failing", url: "https://ci/1", workflow: "CI" },
        { name: "deploy", status: "pending", url: "https://d", workflow: null },
      ]);
    });

    it("flags a PR as queued to merge when auto-merge is armed", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(43, { autoMergeRequest: { enabledAt: "2026-09-08T00:00:00Z" } }))),
        success(conversation({})),
      ]);

      const result = await manager.getPrForBranch(REPO, "feat/auto");
      expect(result!.queuedToMerge).toBe(true);
    });

    it("flags a PR as queued to merge when it sits in the merge queue", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(44, { isInMergeQueue: true }))),
        success(conversation({})),
      ]);

      const result = await manager.getPrForBranch(REPO, "feat/queued");
      expect(result!.queuedToMerge).toBe(true);
    });

    it("returns null when the branch has no PR", async () => {
      setupExecFileCalls([success(prsAnswer(null))]);

      const result = await manager.getPrForBranch(REPO, "no-pr-branch");
      expect(result).toBeNull();
    });

    it("returns null when gh command fails", async () => {
      setupExecFileCalls([failure("command failed")]);

      const result = await manager.getPrForBranch(REPO, "some-branch");
      expect(result).toBeNull();
    });

    it("correctly computes checks summary with SUCCESS, FAILURE, CANCELLED, TIMED_OUT, and pending", async () => {
      setupExecFileCalls([
        success(
          prsAnswer(
            pr(1, rollup(
              { conclusion: "SUCCESS" },
              { conclusion: "FAILURE" },
              { conclusion: "CANCELLED" },
              { conclusion: "TIMED_OUT" },
              { conclusion: null }, // pending
              { conclusion: "IN_PROGRESS" }, // pending
            )),
          ),
        ),
        success(conversation({ reviewThreads: { nodes: [] } })),
      ]);

      const result = await manager.getPrForBranch(REPO, "branch");
      expect(result!.checks).toEqual({
        total: 6,
        passing: 1,
        failing: 3,
        pending: 2,
        skipped: 0,
      });
    });

    it("sets checks to null when the rollup is empty or missing", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(1, rollup()), pr(2, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }))),
        success(conversation({}, {})),
      ]);

      const results = await manager.getPrsForBranches(REPO, ["a", "b"]);
      expect(results.map(([, p]) => p!.checks)).toEqual([null, null]);
    });
  });

  describe("getPrsForBranches", () => {
    it("asks for every branch in one gh call, and every conversation in one more", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(7), null, pr(8))),
        success(conversation({ reviewThreads: { nodes: [{ isResolved: false }] } }, {})),
      ]);

      const results = await manager.getPrsForBranches(REPO, ["branch-a", "branch-b", "branch-c"]);

      expect(results.map(([b, p]) => [b, p?.number ?? null])).toEqual([
        ["branch-a", 7],
        ["branch-b", null],
        ["branch-c", 8],
      ]);
      expect(results[0][1]!.unresolvedThreads).toBe(1);
      expect(mockState.calls).toHaveLength(2);
      expect(mockState.calls[0]).toEqual(
        expect.arrayContaining(["h0=branch-a", "h1=branch-b", "h2=branch-c"]),
      );
      const conversationQuery = mockState.calls[1].find((a) => a.startsWith("query="))!;
      expect(conversationQuery).toContain("p0: pullRequest(number: 7)");
      expect(conversationQuery).toContain("p1: pullRequest(number: 8)");
      // The repo goes in as variables, not spliced into the query.
      expect(conversationQuery).toContain("r0: repository(owner: $o0, name: $n0)");
      expect(mockState.calls[1]).toEqual(expect.arrayContaining(["o0=owner", "n0=repo"]));
    });

    it("never queries a merged or closed PR's branch again", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(1, { state: "MERGED" }), pr(2, { state: "CLOSED" }), pr(3))),
        success(conversation({}, {}, {})),
        // Next poll: only the open PR's branch is asked about.
        success(prsAnswer(pr(3))),
      ]);

      await manager.getPrsForBranches(REPO, ["merged", "closed", "open"]);
      const second = await manager.getPrsForBranches(REPO, ["merged", "closed", "open"]);

      expect(second.map(([, p]) => p!.state)).toEqual(["merged", "closed", "open"]);
      const branchArgs = mockState.calls[2].filter((a) => /^h\d+=/.test(a));
      expect(branchArgs).toEqual(["h0=open"]);
      expect(mockState.queue).toHaveLength(0);
    });

    it("runs no gh at all when every branch's PR is final", async () => {
      setupExecFileCalls([
        success(prsAnswer(pr(1, { state: "MERGED" }))),
        success(conversation({})),
      ]);
      await manager.getPrsForBranches(REPO, ["done"]);
      const calls = mockState.calls.length;

      const again = await manager.getPrsForBranches(REPO, ["done"]);
      expect(again[0][1]!.number).toBe(1);
      expect(mockState.calls).toHaveLength(calls);
    });

    it("shares one lookup between concurrent calls for the same branches", async () => {
      setupExecFileCalls([success(prsAnswer(null, null))]);

      const [a, b] = await Promise.all([
        manager.getPrsForBranches(REPO, ["x", "y"]),
        manager.getPrsForBranches(REPO, ["y", "x"]),
      ]);

      expect(a).toEqual([["x", null], ["y", null]]);
      expect(b).toEqual([["y", null], ["x", null]]);
      expect(mockState.calls).toHaveLength(1);
    });

    it("returns [branch, null] for every branch when the query fails", async () => {
      setupExecFileCalls([failure("gh not found")]);

      const results = await manager.getPrsForBranches(REPO, ["bad-branch", "other"]);
      expect(results).toEqual([["bad-branch", null], ["other", null]]);
    });
  });

  describe("conversation cache", () => {
    const at = (updatedAt: string, over: Record<string, unknown> = {}) =>
      prsAnswer(pr(9, { updatedAt, ...over }));
    const threads = (unresolved: number) =>
      conversation({
        reviewThreads: {
          nodes: Array.from({ length: unresolved }, () => ({ isResolved: false })),
        },
      });

    it("skips the conversation query while updatedAt is unchanged", async () => {
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z")), // poll 1: PRs
        success(threads(2)), // poll 1: conversation
        success(at("2026-09-06T10:00:00Z")), // poll 2: PRs only
      ]);

      const first = await manager.getPrForBranch(REPO, "b");
      const second = await manager.getPrForBranch(REPO, "b");
      expect(first!.unresolvedThreads).toBe(2);
      expect(second!.unresolvedThreads).toBe(2);
      expect(mockState.queue).toHaveLength(0);
    });

    it("sees the PR join the merge queue without re-querying the conversation", async () => {
      // Joining the queue leaves updatedAt alone, so the cached conversation
      // must not be where the flag comes from.
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z")),
        success(threads(0)),
        success(at("2026-09-06T10:00:00Z", { isInMergeQueue: true })),
      ]);

      const first = await manager.getPrForBranch(REPO, "b");
      const second = await manager.getPrForBranch(REPO, "b");
      expect(first!.queuedToMerge).toBe(false);
      expect(second!.queuedToMerge).toBe(true);
      expect(mockState.queue).toHaveLength(0);
    });

    it("re-queries when updatedAt moves", async () => {
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z")),
        success(threads(2)),
        success(at("2026-09-06T11:00:00Z")),
        success(threads(0)),
      ]);

      await manager.getPrForBranch(REPO, "b");
      const second = await manager.getPrForBranch(REPO, "b");
      expect(second!.unresolvedThreads).toBe(0);
      expect(mockState.queue).toHaveLength(0);
    });

    it("reports a merged PR to the merged listener when it is queried", async () => {
      const seen = vi.fn();
      manager.setPrMergedListener(seen);
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z")),
        success(threads(0)),
        // The conversation is still cached and fresh, so the merged poll is
        // the PR query alone.
        success(at("2026-09-06T10:00:00Z", { state: "MERGED" })),
      ]);

      await manager.getPrForBranch(REPO, "b"); // open: silent
      expect(seen).not.toHaveBeenCalled();

      await manager.getPrForBranch(REPO, "b");
      await manager.getPrForBranch(REPO, "b"); // final: not queried again
      expect(seen.mock.calls).toEqual([["https://github.com/owner/repo/pull/9"]]);
      expect(mockState.queue).toHaveLength(0);
    });

    it("still returns PR info when the merged listener throws", async () => {
      manager.setPrMergedListener(() => {
        throw new Error("stats exploded");
      });
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z", { state: "MERGED" })),
        success(threads(0)),
      ]);

      const result = await manager.getPrForBranch(REPO, "b");
      expect(result!.state).toBe("merged");
    });

    it("does not cache a failed conversation query", async () => {
      setupExecFileCalls([
        success(at("2026-09-06T10:00:00Z")),
        failure("GraphQL: API rate limit already exceeded"),
        success(at("2026-09-06T10:00:00Z")),
        success(threads(1)),
      ]);

      const first = await manager.getPrForBranch(REPO, "b");
      expect(first!.unresolvedThreads).toBeUndefined();
      const second = await manager.getPrForBranch(REPO, "b");
      expect(second!.unresolvedThreads).toBe(1);
      expect(mockState.queue).toHaveLength(0);
    });
  });
  // -------------------------------------------------------------------------
  // getMyIssues
  // -------------------------------------------------------------------------
  describe("getMyIssues", () => {
    it("returns parsed JSON array on success", async () => {
      const issues = [
        {
          number: 1,
          title: "Issue 1",
          url: "https://github.com/o/r/issues/1",
          state: "open",
          labels: [],
          assignees: [],
        },
      ];
      setupExecFileCalls([success(JSON.stringify(issues))]);

      const result = await manager.getMyIssues(REPO);
      expect(result).toEqual(issues);
    });

    it("asks for every list field including projectItems", async () => {
      setupExecFileCalls([success("[]")]);

      await manager.getMyIssues(REPO);

      const args = mockState.calls[0];
      const fields = args[args.indexOf("--json") + 1].split(",");
      expect(fields).toEqual(
        expect.arrayContaining([
          "createdAt",
          "closedAt",
          "milestone",
          "comments",
          "stateReason",
          "projectItems",
        ]),
      );
    });

    it("maps comments to commentCount and normalises projectItems", async () => {
      setupExecFileCalls([
        success(
          JSON.stringify([
            {
              number: 1,
              title: "A",
              comments: [{ body: "x" }, { body: "y" }],
              milestone: { title: "v1" },
              projectItems: [
                { title: "Roadmap", status: { name: "In Progress" } },
                { title: "Bare" },
                { status: { name: "no title" } },
              ],
            },
            { number: 2, title: "B" },
          ]),
        ),
      ]);

      const [a, b] = await manager.getMyIssues(REPO);

      expect(a.commentCount).toBe(2);
      expect(a).not.toHaveProperty("comments");
      expect(a.milestone).toEqual({ title: "v1" });
      expect(a.projectItems).toEqual([
        { title: "Roadmap", status: "In Progress" },
        { title: "Bare" },
      ]);
      expect(b.commentCount).toBeUndefined();
      expect(b.projectItems).toBeUndefined();
    });

    it("retries once without projectItems on a missing-scope error", async () => {
      setupExecFileCalls([
        failure("gh failed", {
          stderr:
            "Your token has not been granted the required scopes: ['read:project']",
        }),
        success(JSON.stringify([{ number: 1, title: "A", comments: [] }])),
      ]);

      const result = await manager.getMyIssues(REPO);

      expect(result[0].commentCount).toBe(0);
      expect(mockState.calls).toHaveLength(2);
      const fields = (args: string[]) => args[args.indexOf("--json") + 1];
      expect(fields(mockState.calls[0])).toContain("projectItems");
      expect(fields(mockState.calls[1])).not.toContain("projectItems");
    });

    it("leaves projectItems out after a missing-scope error", async () => {
      setupExecFileCalls([
        failure("gh failed", { stderr: "requires one of: ['read:project']" }),
        success("[]"),
        success("[]"),
      ]);

      await manager.getMyIssues(REPO);
      await manager.getAllIssues(REPO);

      expect(mockState.calls).toHaveLength(3);
      const fields = (args: string[]) => args[args.indexOf("--json") + 1];
      expect(fields(mockState.calls[2])).not.toContain("projectItems");
    });

    it("does not retry other errors", async () => {
      setupExecFileCalls([failure("boom", { stderr: "network down" })]);

      await expect(manager.getMyIssues(REPO)).rejects.toThrow();
      expect(mockState.calls).toHaveLength(1);
    });

    // A swallowed error made a broken `gh` indistinguishable from an empty
    // backlog. Rejecting lets the MCP route answer 502 and the UI show a
    // failure instead of "no issues".
    it("throws on failure rather than reporting an empty backlog", async () => {
      setupExecFileCalls([failure("gh failed")]);

      await expect(manager.getMyIssues(REPO)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getAllIssues
  // -------------------------------------------------------------------------
  describe("getAllIssues", () => {
    it("returns parsed JSON array on success", async () => {
      const issues = [
        {
          number: 5,
          title: "Bug",
          url: "https://github.com/o/r/issues/5",
          state: "open",
          labels: [{ name: "bug", color: "red" }],
          assignees: [{ login: "alice" }],
        },
      ];
      setupExecFileCalls([success(JSON.stringify(issues))]);

      const result = await manager.getAllIssues(REPO);
      expect(result).toEqual(issues);
    });

    it("throws on failure rather than reporting an empty backlog", async () => {
      setupExecFileCalls([failure("gh error")]);

      await expect(manager.getAllIssues(REPO)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // getIssueDetail
  // -------------------------------------------------------------------------
  describe("getIssueDetail", () => {
    it("returns parsed issue detail on success", async () => {
      const detail = {
        number: 10,
        title: "Detailed Issue",
        url: "https://github.com/o/r/issues/10",
        state: "open",
        body: "Some body text",
        labels: [],
        assignees: [],
        milestone: { title: "v1.0" },
      };
      setupExecFileCalls([success(JSON.stringify(detail))]);

      const result = await manager.getIssueDetail(REPO, 10);
      expect(result).toEqual(detail);
    });

    it("looks the issue up by URL when one is given", async () => {
      const url = "https://github.com/other/repo/issues/10";
      setupExecFileCalls([success(JSON.stringify({ number: 10, url }))]);

      await manager.getIssueDetail(REPO, 10, url);
      expect(mockState.calls[0]).toContain(url);
    });

    it("throws on failure (no try/catch in this method)", async () => {
      setupExecFileCalls([failure("gh issue view failed")]);

      await expect(manager.getIssueDetail(REPO, 10)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // checkStatus
  // -------------------------------------------------------------------------
  describe("checkStatus", () => {
    it("returns installed:true, authenticated:true with username on success", async () => {
      setupExecFileCalls([
        success("Logged in to github.com account testuser (keyring)\n", ""),
      ]);

      const result = await manager.checkStatus();
      expect(result).toEqual({
        installed: true,
        authenticated: true,
        username: "testuser",
      });
    });

    it("returns installed:true, authenticated:false when stderr contains 'not logged in'", async () => {
      setupExecFileCalls([
        failure("gh auth status failed", {
          stderr: "You are not logged in to any GitHub hosts.",
          stdout: "",
        }),
      ]);

      const result = await manager.checkStatus();
      expect(result).toEqual({ installed: true, authenticated: false });
    });

    it("returns installed:false, authenticated:false when command fails with ENOENT", async () => {
      setupExecFileCalls([
        failure("spawn gh ENOENT", { code: "ENOENT", stderr: "", stdout: "" }),
      ]);

      const result = await manager.checkStatus();
      expect(result).toEqual({ installed: false, authenticated: false });
    });
  });

  // -------------------------------------------------------------------------
  // createIssue
  // -------------------------------------------------------------------------
  describe("createIssue", () => {
    it("returns { url } on success with labels", async () => {
      setupExecFileCalls([
        success("https://github.com/orrybaram/manor/issues/99\n"),
      ]);

      const result = await manager.createIssue("My Issue", "Body", ["bug"]);
      expect(result).toEqual({
        url: "https://github.com/orrybaram/manor/issues/99",
      });
    });

    it("retries without labels when first attempt fails, returns { url }", async () => {
      setupExecFileCalls([
        failure("label does not exist"), // first attempt with labels fails
        success("https://github.com/orrybaram/manor/issues/100\n"), // retry without labels
      ]);

      const result = await manager.createIssue("Title", "Body", [
        "nonexistent-label",
      ]);
      expect(result).toEqual({
        url: "https://github.com/orrybaram/manor/issues/100",
      });
    });

    it("returns null when both attempts fail", async () => {
      setupExecFileCalls([
        failure("fail 1"), // with labels
        failure("fail 2"), // without labels
      ]);

      const result = await manager.createIssue("Title", "Body", ["label"]);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // assignIssue
  // -------------------------------------------------------------------------
  // Previously swallowed failures and reported unqualified success — a caller
  // that requested `assign: true` had no way to learn the assignment never
  // happened. Now rejects, matching getMyIssues/getIssueDetail.
  describe("assignIssue", () => {
    it("throws on failure rather than silently no-op'ing", async () => {
      setupExecFileCalls([failure("gh error")]);

      await expect(manager.assignIssue(REPO, 5)).rejects.toThrow();
    });

    it("completes without error on success", async () => {
      setupExecFileCalls([success("")]);

      await expect(manager.assignIssue(REPO, 5)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // closeIssue
  // -------------------------------------------------------------------------
  // Despite the old "fire-and-forget" comment, this was awaited by UI callers
  // that told the user the issue was closed regardless of outcome. Now
  // rejects so callers can revert an optimistic update / keep a dialog open.
  describe("closeIssue", () => {
    it("throws on failure rather than reporting a closed issue that isn't", async () => {
      setupExecFileCalls([failure("gh error")]);

      await expect(manager.closeIssue(REPO, 5)).rejects.toThrow();
    });

    it("completes without error on success", async () => {
      setupExecFileCalls([success("")]);

      await expect(manager.closeIssue(REPO, 5)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Remote projects (ADR-160): the checkout is on another host, so `gh` runs
  // here against the repo the resolver names instead of inside the path.
  // -------------------------------------------------------------------------
  describe("remote projects", () => {
    function resolver(
      repoFor: (hostId: string, path: string) => Promise<string>,
    ) {
      return vi.fn(repoFor);
    }

    it("targets the resolved repo instead of running in the remote path", async () => {
      const remote = new GitHubManager(resolver(async () => "owner/repo"));
      setupExecFileCalls([success("[]")]);

      await remote.getMyIssues({ path: "/remote/repo", hostId: "box" });

      expect(mockState.calls[0]).toEqual(
        expect.arrayContaining(["issue", "list", "--repo", "owner/repo"]),
      );
      expect(mockState.cwds[0]).toBeUndefined();
    });

    it("points the PR query's repo placeholders at the resolved repo", async () => {
      const remote = new GitHubManager(resolver(async () => "ghe.example.com/owner/repo"));
      setupExecFileCalls([success(prsAnswer(null))]);

      await remote.getPrForBranch({ path: "/remote/repo", hostId: "box" }, "feat/x");

      expect(mockState.calls[0]).toEqual(
        expect.arrayContaining(["--hostname", "ghe.example.com", "owner={owner}"]),
      );
      expect(mockState.cwds[0]).toBeUndefined();
      expect(mockState.envs[0]?.GH_REPO).toBe("ghe.example.com/owner/repo");
    });

    it("keeps running local checkouts in their directory", async () => {
      const resolve = resolver(async () => "owner/repo");
      const remote = new GitHubManager(resolve);
      setupExecFileCalls([success("[]")]);

      await remote.getAllIssues({ path: "/local/repo", hostId: "local" });

      expect(mockState.calls[0]).not.toContain("--repo");
      expect(mockState.cwds[0]).toBe("/local/repo");
      expect(resolve).not.toHaveBeenCalled();
    });

    it("resolves a remote checkout's repo once", async () => {
      const resolve = resolver(async () => "owner/repo");
      const remote = new GitHubManager(resolve);
      setupExecFileCalls([success("[]"), success("[]")]);

      await remote.getMyIssues({ path: "/remote/repo", hostId: "box" });
      await remote.getMyIssues({ path: "/remote/repo", hostId: "box" });

      expect(resolve).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledWith("box", "/remote/repo");
    });

    it("reports no PR when the repo cannot be resolved", async () => {
      const remote = new GitHubManager(
        resolver(async () => {
          throw new Error("no origin");
        }),
      );

      await expect(
        remote.getPrForBranch(
          { path: "/remote/repo", hostId: "box" },
          "feat/x",
        ),
      ).resolves.toBeNull();
    });

    // ADR-191: the same path on two hosts is two checkouts.
    it("keeps separate cache entries for the same path on two hosts", async () => {
      const resolve = resolver(async (hostId) => `owner/${hostId}-repo`);
      const remote = new GitHubManager(resolve);
      setupExecFileCalls([
        success("[]"),
        success("[]"),
        success("[]"),
        success("[]"),
        success("[]"),
      ]);

      await remote.getMyIssues({ path: "/srv/repo", hostId: "box" });
      await remote.getMyIssues({ path: "/srv/repo", hostId: "other" });
      await remote.getMyIssues({ path: "/srv/repo", hostId: "box" });
      await remote.getMyIssues({ path: "/srv/repo", hostId: "other" });
      await remote.getMyIssues({ path: "/srv/repo", hostId: "local" });

      expect(resolve).toHaveBeenCalledTimes(2);
      const repoArg = (args: string[]) =>
        args.includes("--repo") ? args[args.indexOf("--repo") + 1] : null;
      expect(mockState.calls.map(repoArg)).toEqual([
        "owner/box-repo",
        "owner/other-repo",
        "owner/box-repo",
        "owner/other-repo",
        null,
      ]);
      expect(mockState.cwds[4]).toBe("/srv/repo");
    });
  });
});

describe("ghRepoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "owner/repo"],
    ["https://github.com/owner/repo", "owner/repo"],
    ["git@github.com:owner/repo.git", "owner/repo"],
    ["ssh://git@github.com/owner/repo.git", "owner/repo"],
    ["ssh://git@github.com:22/owner/repo", "owner/repo"],
    ["https://ghe.example.com/owner/repo.git", "ghe.example.com/owner/repo"],
  ])("%s -> %s", (url, repo) => {
    expect(ghRepoFromRemoteUrl(url)).toBe(repo);
  });

  it("rejects a URL without an owner/repo path", () => {
    expect(ghRepoFromRemoteUrl("/srv/git/repo.git")).toBeNull();
    expect(ghRepoFromRemoteUrl("https://github.com/owner")).toBeNull();
  });
});

describe("GitHubManager.listRepos", () => {
  const line = (name: string, pushed: string | null) =>
    JSON.stringify({
      full_name: name,
      description: null,
      private: false,
      ssh_url: `git@github.com:${name}.git`,
      clone_url: `https://github.com/${name}.git`,
      pushed_at: pushed,
    });

  it("parses one object per line, newest push first, https by default", async () => {
    setupExecFileCalls([
      success("\n"),
      success(
        [
          line("a/old", "2024-01-01T00:00:00Z"),
          line("a/new", "2025-01-01T00:00:00Z"),
        ].join("\n") + "\n",
      ),
    ]);
    const repos = await new GitHubManager().listRepos();
    expect(repos.map((r) => r.nameWithOwner)).toEqual(["a/new", "a/old"]);
    expect(repos[0].cloneUrl).toBe("https://github.com/a/new.git");
  });

  it("uses the ssh url when git_protocol is ssh", async () => {
    setupExecFileCalls([success("ssh\n"), success(line("a/b", null) + "\n")]);
    const repos = await new GitHubManager().listRepos();
    expect(repos[0].cloneUrl).toBe("git@github.com:a/b.git");
  });

  it("returns [] when gh fails, and caches successes", async () => {
    setupExecFileCalls([failure("nope"), failure("nope")]);
    expect(await new GitHubManager().listRepos()).toEqual([]);

    setupExecFileCalls([success("ssh"), success(line("a/b", null))]);
    const mgr = new GitHubManager();
    await mgr.listRepos();
    await mgr.listRepos();
    expect(mockState.calls).toHaveLength(2);
  });
});
