import { describe, it, expect, beforeEach, vi, type MockedFunction } from "vitest";
import { LinearManager } from "./linear";

// Mock electron safeStorage
vi.mock("electron", () => ({
  safeStorage: {
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString().replace("enc:", "")),
  },
}));

// Mock node:fs
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
    unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(body: unknown, ok = true, status = 200, statusText = "OK") {
  return {
    ok,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("LinearManager", () => {
  let manager: LinearManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new LinearManager();
  });

  // ─── Token management ────────────────────────────────────────────────────────

  describe("saveToken", () => {
    it("encrypts via safeStorage and writes to linear-token.enc", () => {
      manager.saveToken("lin_api_test123");

      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining("Manor"),
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining("linear-token.enc"),
        Buffer.from("enc:lin_api_test123"),
      );
    });
  });

  describe("getToken", () => {
    it("reads and decrypts the token, returning a string", () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      const token = manager.getToken();

      expect(token).toBe("mytoken");
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining("linear-token.enc"),
      );
    });

    it("returns null when file doesn't exist", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      expect(manager.getToken()).toBeNull();
    });
  });

  describe("clearToken", () => {
    it("deletes the token file", () => {
      manager.clearToken();

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining("linear-token.enc"),
      );
    });

    it("doesn't throw when file doesn't exist", () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });

      expect(() => manager.clearToken()).not.toThrow();
    });
  });

  describe("isConnected", () => {
    it("returns true when token is present", () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));
      expect(manager.isConnected()).toBe(true);
    });

    it("returns false when token is absent", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      expect(manager.isConnected()).toBe(false);
    });
  });

  // ─── GraphQL client (via public methods) ─────────────────────────────────────

  describe("getViewer", () => {
    it("sends correct query and returns viewer data", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));
      mockFetch.mockResolvedValue(
        makeFetchResponse({ data: { viewer: { name: "Alice", email: "alice@example.com" } } }),
      );

      const viewer = await manager.getViewer();

      expect(viewer).toEqual({ name: "Alice", email: "alice@example.com" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.linear.app/graphql",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "mytoken" }),
        }),
      );
      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.query).toContain("viewer");
    });

    it("throws 'Not connected to Linear' when no token", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      await expect(manager.getViewer()).rejects.toThrow("Not connected to Linear");
    });

    it("throws on non-OK HTTP response with status info", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));
      mockFetch.mockResolvedValue(
        makeFetchResponse("Unauthorized", false, 401, "Unauthorized"),
      );

      await expect(manager.getViewer()).rejects.toThrow("Linear API error: 401 Unauthorized");
    });

    it("throws on GraphQL errors array", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));
      mockFetch.mockResolvedValue(
        makeFetchResponse({ errors: [{ message: "Field not found" }] }),
      );

      await expect(manager.getViewer()).rejects.toThrow("Field not found");
    });

    it("throws 'No data returned' when response has no data field", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));
      mockFetch.mockResolvedValue(makeFetchResponse({}));

      await expect(manager.getViewer()).rejects.toThrow("No data returned from Linear API");
    });
  });

  // ─── Issue operations ─────────────────────────────────────────────────────────

  describe("getMyIssues", () => {
    it("returns empty array when teamIds is empty", async () => {
      const result = await manager.getMyIssues([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends correct query variables, sorts by state type then priority, slices to limit", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      const rawNodes = [
        {
          id: "1",
          identifier: "ENG-1",
          title: "Backlog issue",
          url: "https://linear.app/1",
          branchName: "eng-1",
          priority: 1,
          state: { name: "Backlog", type: "backlog" },
          labels: { nodes: [{ name: "bug", color: "#ff0000" }] },
        },
        {
          id: "2",
          identifier: "ENG-2",
          title: "In progress issue",
          url: "https://linear.app/2",
          branchName: "eng-2",
          priority: 2,
          state: { name: "In Progress", type: "unstarted" },
          labels: { nodes: [] },
        },
        {
          id: "3",
          identifier: "ENG-3",
          title: "Another unstarted",
          url: "https://linear.app/3",
          branchName: "eng-3",
          priority: 1,
          state: { name: "Todo", type: "unstarted" },
          labels: { nodes: [] },
        },
      ];

      mockFetch.mockResolvedValue(
        makeFetchResponse({
          data: { viewer: { assignedIssues: { nodes: rawNodes } } },
        }),
      );

      // limit=2 — should return the 2 highest priority unstarted issues
      const issues = await manager.getMyIssues(["team-1"], { stateTypes: ["unstarted", "backlog"], limit: 2 });

      // unstarted issues come before backlog, sorted by priority within group
      expect(issues).toHaveLength(2);
      expect(issues[0].id).toBe("3"); // unstarted, priority 1
      expect(issues[1].id).toBe("2"); // unstarted, priority 2

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.variables.teamIds).toEqual(["team-1"]);
      expect(body.variables.stateTypes).toEqual(["unstarted", "backlog"]);
      expect(body.variables.first).toBe(4); // limit * 2 = 4

      // labels should be flattened from nodes
      expect(issues[0].labels).toEqual([]);
    });
  });

  describe("getAllIssues", () => {
    it("returns empty array when teamIds is empty", async () => {
      const result = await manager.getAllIssues([]);
      expect(result).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends correct query variables, sorts by state type then priority, slices to limit", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      const rawNodes = [
        {
          id: "10",
          identifier: "ENG-10",
          title: "Backlog",
          url: "u",
          branchName: "b",
          priority: 3,
          state: { name: "Backlog", type: "backlog" },
          labels: { nodes: [] },
        },
        {
          id: "11",
          identifier: "ENG-11",
          title: "Todo",
          url: "u",
          branchName: "b",
          priority: 1,
          state: { name: "Todo", type: "unstarted" },
          labels: { nodes: [{ name: "feature", color: "#00ff00" }] },
        },
      ];

      mockFetch.mockResolvedValue(
        makeFetchResponse({ data: { issues: { nodes: rawNodes } } }),
      );

      const issues = await manager.getAllIssues(["team-2"], { limit: 5 });

      expect(issues[0].id).toBe("11"); // unstarted first
      expect(issues[1].id).toBe("10"); // backlog second
      expect(issues[0].labels).toEqual([{ name: "feature", color: "#00ff00" }]);

      const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(body.variables.teamIds).toEqual(["team-2"]);
      expect(body.variables.first).toBe(10); // limit * 2 = 10
    });
  });

  describe("getIssueDetail", () => {
    it("flattens labels.nodes to labels", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      mockFetch.mockResolvedValue(
        makeFetchResponse({
          data: {
            issue: {
              id: "abc",
              identifier: "ENG-99",
              title: "Detail issue",
              url: "https://linear.app/abc",
              branchName: "eng-99",
              priority: 0,
              description: "Some description",
              state: { name: "Todo", type: "unstarted" },
              labels: { nodes: [{ id: "lbl-1", name: "critical", color: "#ff0000" }] },
              assignee: null,
            },
          },
        }),
      );

      const detail = await manager.getIssueDetail("abc");

      expect(detail.labels).toEqual([{ id: "lbl-1", name: "critical", color: "#ff0000" }]);
      expect(detail.description).toBe("Some description");
      expect(detail.assignee).toBeNull();
    });
  });

  // ─── autoMatchProjects ────────────────────────────────────────────────────────

  describe("autoMatchProjects", () => {
    const teams = [
      { id: "t1", name: "Manor", key: "MNR" },
      { id: "t2", name: "Infra", key: "INF" },
    ];

    it("matches project 'manor' to team 'Manor'", () => {
      const result = manager.autoMatchProjects(
        [{ id: "p1", name: "manor" }],
        teams,
      );
      expect(result["p1"]).toEqual({ teamId: "t1", teamName: "Manor", teamKey: "MNR" });
    });

    it("normalizes suffixes: 'manor-app' matches team 'Manor'", () => {
      const result = manager.autoMatchProjects(
        [{ id: "p2", name: "manor-app" }],
        teams,
      );
      expect(result["p2"]).toEqual({ teamId: "t1", teamName: "Manor", teamKey: "MNR" });
    });

    it("normalizes other suffixes: 'infra-service' matches team 'Infra'", () => {
      const result = manager.autoMatchProjects(
        [{ id: "p3", name: "infra-service" }],
        teams,
      );
      expect(result["p3"]).toEqual({ teamId: "t2", teamName: "Infra", teamKey: "INF" });
    });

    it("returns empty object when no matches", () => {
      const result = manager.autoMatchProjects(
        [{ id: "p4", name: "completely-unrelated-xyz" }],
        teams,
      );
      expect(result).toEqual({});
    });

    it("is case insensitive", () => {
      const result = manager.autoMatchProjects(
        [{ id: "p5", name: "MANOR" }],
        teams,
      );
      expect(result["p5"]).toEqual({ teamId: "t1", teamName: "Manor", teamKey: "MNR" });
    });
  });

  // ─── Fire-and-forget methods ──────────────────────────────────────────────────

  describe("startIssue", () => {
    it("finds 'In Progress' state and updates issue", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      const queryResponse = {
        data: {
          issue: {
            assignee: null,
            team: {
              states: {
                nodes: [
                  { id: "s1", name: "Todo", type: "unstarted" },
                  { id: "s2", name: "In Progress", type: "started" },
                  { id: "s3", name: "Done", type: "completed" },
                ],
              },
            },
          },
          viewer: { id: "viewer-1" },
        },
      };

      const mutationResponse = {
        data: { issueUpdate: { success: true } },
      };

      mockFetch
        .mockResolvedValueOnce(makeFetchResponse(queryResponse))
        .mockResolvedValueOnce(makeFetchResponse(mutationResponse));

      await expect(manager.startIssue("issue-1")).resolves.not.toThrow();

      // First call: query
      const queryBody = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
      expect(queryBody.variables.id).toBe("issue-1");

      // Second call: mutation with "In Progress" state
      const mutBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
      expect(mutBody.variables.input.stateId).toBe("s2");
      // assignee should be set since issue.assignee is null
      expect(mutBody.variables.input.assigneeId).toBe("viewer-1");
    });

    it("doesn't throw on failure", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      await expect(manager.startIssue("issue-fail")).resolves.not.toThrow();
    });
  });

  describe("closeIssue", () => {
    it("finds 'Done' state and updates issue", async () => {
      mockReadFileSync.mockReturnValue(Buffer.from("enc:mytoken"));

      const queryResponse = {
        data: {
          issue: {
            team: {
              states: {
                nodes: [
                  { id: "s1", name: "Todo", type: "unstarted" },
                  { id: "s2", name: "In Progress", type: "started" },
                  { id: "s3", name: "Done", type: "completed" },
                ],
              },
            },
          },
        },
      };

      const mutationResponse = {
        data: { issueUpdate: { success: true } },
      };

      mockFetch
        .mockResolvedValueOnce(makeFetchResponse(queryResponse))
        .mockResolvedValueOnce(makeFetchResponse(mutationResponse));

      await expect(manager.closeIssue("issue-2")).resolves.not.toThrow();

      const mutBody = JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string);
      expect(mutBody.variables.input.stateId).toBe("s3");
    });

    it("doesn't throw on failure", async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      await expect(manager.closeIssue("issue-fail")).resolves.not.toThrow();
    });
  });
});
