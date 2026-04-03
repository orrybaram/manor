import { describe, it, expect, vi, beforeEach } from "vitest";
import { promisify } from "node:util";

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
    },
  };
});

vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");

  type ExecFileCb = (
    err: Error | null,
    stdout: string,
    stderr: string,
  ) => void;

  // The callback-based execFile mock — consumed by the promisify.custom below
  function execFile(
    _cmd: string,
    _args: string[],
    _opts: object,
    cb: ExecFileCb,
  ): void {
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
import { GitHubManager } from "./github";

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
  // getPrForBranch
  // -------------------------------------------------------------------------
  describe("getPrForBranch", () => {
    it("returns PR info when gh pr list returns valid JSON with one PR", async () => {
      const prData = [
        {
          number: 42,
          state: "OPEN",
          title: "My PR",
          url: "https://github.com/owner/repo/pull/42",
          isDraft: false,
          additions: 10,
          deletions: 2,
          reviewDecision: "APPROVED",
          statusCheckRollup: [
            { conclusion: "SUCCESS" },
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
          ],
        },
      ];

      const graphqlResponse = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ isResolved: false }, { isResolved: true }],
              },
            },
          },
        },
      };

      setupExecFileCalls([
        success(JSON.stringify(prData)), // gh pr list
        success(JSON.stringify(graphqlResponse)), // gh api graphql (unresolved threads)
      ]);

      const result = await manager.getPrForBranch("/repo", "feat/my-branch");

      expect(result).not.toBeNull();
      expect(result!.number).toBe(42);
      expect(result!.state).toBe("open");
      expect(result!.title).toBe("My PR");
      expect(result!.checks).toEqual({
        total: 3,
        passing: 2,
        failing: 1,
        pending: 0,
      });
      expect(result!.unresolvedThreads).toBe(1);
      expect(result!.reviewDecision).toBe("APPROVED");
    });

    it("returns null when gh pr list returns empty array", async () => {
      setupExecFileCalls([success("[]")]);

      const result = await manager.getPrForBranch("/repo", "no-pr-branch");
      expect(result).toBeNull();
    });

    it("returns null when gh command fails", async () => {
      setupExecFileCalls([failure("command failed")]);

      const result = await manager.getPrForBranch("/repo", "some-branch");
      expect(result).toBeNull();
    });

    it("correctly computes checks summary with SUCCESS, FAILURE, CANCELLED, TIMED_OUT, and pending", async () => {
      const prData = [
        {
          number: 1,
          state: "OPEN",
          title: "Checks PR",
          url: "https://github.com/owner/repo/pull/1",
          isDraft: false,
          additions: 0,
          deletions: 0,
          reviewDecision: null,
          statusCheckRollup: [
            { conclusion: "SUCCESS" },
            { conclusion: "FAILURE" },
            { conclusion: "CANCELLED" },
            { conclusion: "TIMED_OUT" },
            { conclusion: null }, // pending
            { conclusion: "IN_PROGRESS" }, // pending
          ],
        },
      ];

      setupExecFileCalls([
        success(JSON.stringify(prData)),
        success(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          }),
        ),
      ]);

      const result = await manager.getPrForBranch("/repo", "branch");
      expect(result!.checks).toEqual({
        total: 6,
        passing: 1,
        failing: 3,
        pending: 2,
      });
    });

    it("sets checks to null when statusCheckRollup is empty", async () => {
      const prData = [
        {
          number: 1,
          state: "OPEN",
          title: "No Checks PR",
          url: "https://github.com/owner/repo/pull/1",
          isDraft: false,
          additions: 0,
          deletions: 0,
          reviewDecision: null,
          statusCheckRollup: [],
        },
      ];

      setupExecFileCalls([
        success(JSON.stringify(prData)),
        success(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          }),
        ),
      ]);

      const result = await manager.getPrForBranch("/repo", "branch");
      expect(result!.checks).toBeNull();
    });

    it("sets checks to null when statusCheckRollup is missing", async () => {
      const prData = [
        {
          number: 1,
          state: "OPEN",
          title: "No Rollup PR",
          url: "https://github.com/owner/repo/pull/1",
          isDraft: false,
          additions: 0,
          deletions: 0,
          reviewDecision: null,
          // no statusCheckRollup field
        },
      ];

      setupExecFileCalls([
        success(JSON.stringify(prData)),
        success(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          }),
        ),
      ]);

      const result = await manager.getPrForBranch("/repo", "branch");
      expect(result!.checks).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getPrsForBranches
  // -------------------------------------------------------------------------
  describe("getPrsForBranches", () => {
    it("calls getPrForBranchInner for each branch and returns results", async () => {
      const emptyGraphql = JSON.stringify({
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [] } },
          },
        },
      });

      const prSame = JSON.stringify([
        {
          number: 7,
          state: "OPEN",
          title: "PR Same",
          url: "https://github.com/owner/repo/pull/7",
          isDraft: false,
          additions: 0,
          deletions: 0,
          reviewDecision: null,
          statusCheckRollup: [],
        },
      ]);

      // The two branch lookups start concurrently via Promise.allSettled.
      // Because JS is single-threaded, microtasks interleave as:
      //   call 1: branch-a pr list
      //   call 2: branch-b pr list  (both initiated before either resolves)
      //   call 3: branch-a graphql
      //   call 4: branch-b graphql
      setupExecFileCalls([
        success(prSame), // call 1: branch-a pr list
        success(prSame), // call 2: branch-b pr list
        success(emptyGraphql), // call 3: branch-a graphql
        success(emptyGraphql), // call 4: branch-b graphql
      ]);

      const results = await manager.getPrsForBranches("/repo", [
        "branch-a",
        "branch-b",
      ]);

      expect(results).toHaveLength(2);
      expect(results[0][0]).toBe("branch-a");
      expect(results[1][0]).toBe("branch-b");
      expect(results[0][1]).not.toBeNull();
      expect(results[1][1]).not.toBeNull();
      expect(results[0][1]!.number).toBe(7);
      expect(results[1][1]!.number).toBe(7);
    });

    it("returns [branch, null] for branches where the lookup rejects", async () => {
      // getPrForBranchInner catches errors and returns null, so
      // Promise.allSettled fulfills with [branch, null].
      setupExecFileCalls([failure("gh not found")]);

      const results = await manager.getPrsForBranches("/repo", ["bad-branch"]);
      expect(results).toHaveLength(1);
      expect(results[0][0]).toBe("bad-branch");
      expect(results[0][1]).toBeNull();
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

      const result = await manager.getMyIssues("/repo");
      expect(result).toEqual(issues);
    });

    it("returns empty array on failure", async () => {
      setupExecFileCalls([failure("gh failed")]);

      const result = await manager.getMyIssues("/repo");
      expect(result).toEqual([]);
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

      const result = await manager.getAllIssues("/repo");
      expect(result).toEqual(issues);
    });

    it("returns empty array on failure", async () => {
      setupExecFileCalls([failure("gh error")]);

      const result = await manager.getAllIssues("/repo");
      expect(result).toEqual([]);
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

      const result = await manager.getIssueDetail("/repo", 10);
      expect(result).toEqual(detail);
    });

    it("throws on failure (no try/catch in this method)", async () => {
      setupExecFileCalls([failure("gh issue view failed")]);

      await expect(manager.getIssueDetail("/repo", 10)).rejects.toThrow();
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
  // assignIssue — fire-and-forget, must not throw
  // -------------------------------------------------------------------------
  describe("assignIssue", () => {
    it("does not throw on failure", async () => {
      setupExecFileCalls([failure("gh error")]);

      await expect(manager.assignIssue("/repo", 5)).resolves.toBeUndefined();
    });

    it("completes without error on success", async () => {
      setupExecFileCalls([success("")]);

      await expect(manager.assignIssue("/repo", 5)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // closeIssue — fire-and-forget, must not throw
  // -------------------------------------------------------------------------
  describe("closeIssue", () => {
    it("does not throw on failure", async () => {
      setupExecFileCalls([failure("gh error")]);

      await expect(manager.closeIssue("/repo", 5)).resolves.toBeUndefined();
    });

    it("completes without error on success", async () => {
      setupExecFileCalls([success("")]);

      await expect(manager.closeIssue("/repo", 5)).resolves.toBeUndefined();
    });
  });
});
