import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests for the MCP webview server logic.
 *
 * The MCP server (mcp-webview-server.ts) is a standalone script that calls
 * readPort() at module-load time and exits if the port file is missing.
 * Since we can't easily test the full module lifecycle, we test the core
 * behaviours indirectly: port file reading, fetch-based HTTP calls, and
 * pane resolution logic — by replicating the key functions and testing
 * them against a real WebviewServer instance.
 */

// ── Mock electron for the WebviewServer import ──

const mockWebContents: Record<string, unknown> = {
  getURL: vi.fn(() => "https://example.com"),
  getTitle: vi.fn(() => "Test Page"),
  capturePage: vi.fn(),
  executeJavaScript: vi.fn(),
  loadURL: vi.fn(),
  sendInputEvent: vi.fn(),
  isDestroyed: vi.fn(() => false),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("electron", () => ({
  webContents: {
    fromId: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(),
  },
  // requestRenderer installs one "app-command-result" listener lazily; the spy
  // lets tests capture it and play the renderer's side of the correlation.
  ipcMain: {
    on: vi.fn(),
  },
}));

import { WebviewServer } from "../webview-server";
import { requestRenderer } from "../renderer-bridge";
import type { AppCommand, AppCommandResult } from "../renderer-bridge";
import { webContents, BrowserWindow, ipcMain } from "electron";
import { webviewModule } from "../mcp/tools-webview";
import { projectsModule } from "../mcp/tools-projects";
import { agentsModule } from "../mcp/tools-agents";
import { panesModule } from "../mcp/tools-panes";
import type {
  PersistedLayout,
  PersistedWorkspace,
  PersistedPanel,
  PersistedTab,
  PersistedPaneSession,
} from "../terminal-host/layout-persistence";

// ── Replicate MCP server helper functions for testing ──

interface WebviewInfo {
  paneId: string;
  url: string;
  title: string;
}

async function mcpHttpGet(baseUrl: string, urlPath: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json();
}

async function mcpHttpPost(
  baseUrl: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

async function resolvePaneId(
  baseUrl: string,
  paneId: string | undefined,
): Promise<string> {
  if (paneId) return paneId;

  const webviews = (await mcpHttpGet(baseUrl, "/webviews")) as WebviewInfo[];
  if (webviews.length === 0) {
    throw new Error("No webviews are currently open in Manor.");
  }
  if (webviews.length === 1) {
    return webviews[0].paneId;
  }
  const listing = webviews
    .map((w) => `  - ${w.paneId}: ${w.title} (${w.url})`)
    .join("\n");
  throw new Error(`Multiple webviews open. Specify a paneId:\n${listing}`);
}

// ── Tests ──

describe("MCP webview server logic", () => {
  let server: WebviewServer;
  let registry: Map<string, number>;
  let baseUrl: string;

  beforeEach(async () => {
    registry = new Map<string, number>();

    (webContents.fromId as ReturnType<typeof vi.fn>).mockImplementation(
      (id: number) => {
        if (id === 101 || id === 102) return mockWebContents;
        return null;
      },
    );

    // Reset mocks
    for (const key of Object.keys(mockWebContents)) {
      const fn = mockWebContents[key] as ReturnType<typeof vi.fn>;
      fn.mockClear();
    }
    (mockWebContents.getURL as ReturnType<typeof vi.fn>).mockReturnValue(
      "https://example.com",
    );
    (mockWebContents.getTitle as ReturnType<typeof vi.fn>).mockReturnValue(
      "Test Page",
    );
    (mockWebContents.isDestroyed as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );
    (
      mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
    ).mockResolvedValue("result");
    (mockWebContents.loadURL as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    server = new WebviewServer(registry);
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
  });

  describe("port file reading", () => {
    it("port file contains valid port number", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      const content = fs.readFileSync(portFile, "utf-8").trim();
      const port = parseInt(content, 10);
      expect(port).toBe(server.serverPort);
      expect(port).toBeGreaterThan(0);
      expect(isNaN(port)).toBe(false);
    });

    it("port file is removed on stop", () => {
      const portFile = path.join(
        process.env.HOME || "/tmp",
        ".manor",
        "webview-server-port",
      );
      server.stop();
      expect(fs.existsSync(portFile)).toBe(false);
    });
  });

  describe("fetch-based HTTP calls", () => {
    it("when server is not running, fetch fails with connection error", async () => {
      server.stop();
      // Use a port that's definitely not listening
      await expect(
        mcpHttpGet("http://127.0.0.1:1", "/webviews"),
      ).rejects.toThrow();
    });

    it("tools return error for non-200 responses", async () => {
      // Unknown pane → 404
      await expect(
        mcpHttpPost(baseUrl, "/webview/nonexistent/screenshot"),
      ).rejects.toThrow("HTTP 404");
    });
  });

  describe("paneId auto-resolution", () => {
    it("returns the paneId when explicitly provided", async () => {
      const result = await resolvePaneId(baseUrl, "explicit-id");
      expect(result).toBe("explicit-id");
    });

    it("when one webview exists, uses it automatically", async () => {
      registry.set("only-pane", 101);
      const result = await resolvePaneId(baseUrl, undefined);
      expect(result).toBe("only-pane");
    });

    it("when multiple webviews exist, returns error listing them", async () => {
      registry.set("pane-a", 101);
      registry.set("pane-b", 102);
      await expect(resolvePaneId(baseUrl, undefined)).rejects.toThrow(
        "Multiple webviews open",
      );
    });

    it("when no webviews exist, returns descriptive error", async () => {
      // registry is empty by default
      await expect(resolvePaneId(baseUrl, undefined)).rejects.toThrow(
        "No webviews are currently open",
      );
    });
  });

  describe("tool response formatting", () => {
    it("list_webviews returns webview listing via HTTP", async () => {
      registry.set("pane-1", 101);
      const webviews = (await mcpHttpGet(
        baseUrl,
        "/webviews",
      )) as WebviewInfo[];
      expect(webviews).toHaveLength(1);
      expect(webviews[0].paneId).toBe("pane-1");
      expect(webviews[0].url).toBe("https://example.com");
      expect(webviews[0].title).toBe("Test Page");
    });

    it("get_url returns URL string via HTTP", async () => {
      registry.set("pane-1", 101);
      const result = (await mcpHttpGet(baseUrl, "/webview/pane-1/url")) as {
        url: string;
      };
      expect(result.url).toBe("https://example.com");
    });

    it("execute_js returns result via HTTP", async () => {
      registry.set("pane-1", 101);
      (
        mockWebContents.executeJavaScript as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        answer: 42,
      });
      const result = (await mcpHttpPost(baseUrl, "/webview/pane-1/execute-js", {
        code: "({answer: 42})",
      })) as { result: unknown };
      expect(result.result).toEqual({ answer: 42 });
    });

    it("navigate calls loadURL and returns success", async () => {
      registry.set("pane-1", 101);
      const result = (await mcpHttpPost(baseUrl, "/webview/pane-1/navigate", {
        url: "https://new-url.com",
      })) as { ok: boolean };
      expect(result.ok).toBe(true);
      expect(mockWebContents.loadURL).toHaveBeenCalledWith(
        "https://new-url.com",
      );
    });
  });
});

// ── Project & workspace routes ──

async function mcpHttpDelete(
  baseUrl: string,
  urlPath: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: "DELETE",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

describe("WebviewServer project/workspace routes", () => {
  const PROJECT = {
    id: "proj-1",
    name: "demo",
    path: "/repos/demo",
    defaultBranch: "main",
    workspaces: [
      { path: "/repos/demo", branch: "main", isMain: true, name: null },
    ],
  };

  let server: WebviewServer;
  let baseUrl: string;
  let pm: {
    getProjects: ReturnType<typeof vi.fn>;
    addProject: ReturnType<typeof vi.fn>;
    createWorktree: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    pm = {
      getProjects: vi.fn(async () => [PROJECT]),
      addProject: vi.fn(async (name: string, p: string) => ({
        ...PROJECT,
        id: "proj-new",
        name,
        path: p,
      })),
      createWorktree: vi.fn(async () => ({
        ...PROJECT,
        workspaces: [
          ...PROJECT.workspaces,
          {
            path: "/repos/demo-ws",
            branch: "feature",
            isMain: false,
            name: null,
          },
        ],
      })),
      removeWorktree: vi.fn(async () => {}),
    };
    // Every mutating route broadcasts to the renderer; tests that care about the
    // broadcast swap in a window with a spied `send`.
    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue([]);

    // The route handler only uses these four methods of ProjectManager.
    server = new WebviewServer(
      new Map<string, number>(),
      pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
    );
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
  });

  it("GET /projects lists projects", async () => {
    const projects = (await mcpHttpGet(baseUrl, "/projects")) as unknown[];
    expect(projects).toHaveLength(1);
    expect((projects[0] as { id: string }).id).toBe("proj-1");
  });

  it("GET /projects/:id returns the project", async () => {
    const project = (await mcpHttpGet(
      baseUrl,
      "/projects/proj-1",
    )) as { name: string };
    expect(project.name).toBe("demo");
  });

  it("GET /projects/:id 404s for unknown project", async () => {
    await expect(mcpHttpGet(baseUrl, "/projects/nope")).rejects.toThrow(
      "HTTP 404",
    );
  });

  it("POST /projects adds a project", async () => {
    const project = (await mcpHttpPost(baseUrl, "/projects", {
      name: "new",
      path: "/repos/new",
    })) as { id: string };
    expect(project.id).toBe("proj-new");
    expect(pm.addProject).toHaveBeenCalledWith("new", "/repos/new");
  });

  it("POST /projects 400s when name/path missing", async () => {
    await expect(
      mcpHttpPost(baseUrl, "/projects", { name: "only-name" }),
    ).rejects.toThrow("HTTP 400");
  });

  it("GET /projects/:id/workspaces lists workspaces", async () => {
    const workspaces = (await mcpHttpGet(
      baseUrl,
      "/projects/proj-1/workspaces",
    )) as unknown[];
    expect(workspaces).toHaveLength(1);
  });

  it("POST /projects/:id/workspaces creates a workspace", async () => {
    const project = (await mcpHttpPost(
      baseUrl,
      "/projects/proj-1/workspaces",
      { name: "feature", baseBranch: "origin/main" },
    )) as { workspaces: unknown[] };
    expect(project.workspaces).toHaveLength(2);
    expect(pm.createWorktree).toHaveBeenCalledWith(
      "proj-1",
      "feature",
      undefined,
      undefined,
      "origin/main",
      undefined,
    );
  });

  it("POST /projects/:id/workspaces falls back to 'branch' when name is omitted", async () => {
    await mcpHttpPost(baseUrl, "/projects/proj-1/workspaces", {
      branch: "feature",
    });
    expect(pm.createWorktree).toHaveBeenCalledWith(
      "proj-1",
      "feature",
      "feature",
      undefined,
      undefined,
      undefined,
    );
  });

  it("POST /projects/:id/workspaces 400s when name and branch are both missing", async () => {
    await expect(
      mcpHttpPost(baseUrl, "/projects/proj-1/workspaces", {
        baseBranch: "origin/main",
      }),
    ).rejects.toThrow("HTTP 400");
    expect(pm.createWorktree).not.toHaveBeenCalled();
  });

  it("POST /projects/:id/workspaces runs the project's setup script in the new workspace", async () => {
    const send = vi.fn();
    (
      BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ webContents: { send } }]);
    pm.createWorktree.mockResolvedValueOnce({
      ...PROJECT,
      worktreeStartScript: "npm install",
      workspaces: [
        ...PROJECT.workspaces,
        { path: "/repos/demo-ws", branch: "feature", isMain: false, name: null },
      ],
    });

    await mcpHttpPost(baseUrl, "/projects/proj-1/workspaces", {
      name: "feature",
    });

    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "run-setup-script",
      workspacePath: "/repos/demo-ws",
      script: "npm install",
    });
  });

  it("POST /projects/:id/workspaces skips the setup script when the project has none", async () => {
    const send = vi.fn();
    (
      BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ webContents: { send } }]);

    await mcpHttpPost(baseUrl, "/projects/proj-1/workspaces", {
      name: "feature",
    });

    expect(send).not.toHaveBeenCalledWith("app-command", expect.anything());
  });

  it("POST /projects/:id/workspaces tells the renderer its project list is stale", async () => {
    const send = vi.fn();
    (
      BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ webContents: { send } }]);

    await mcpHttpPost(baseUrl, "/projects/proj-1/workspaces", {
      name: "feature",
    });

    expect(send).toHaveBeenCalledWith("projects-changed");
  });

  it("DELETE /projects/:id/workspaces tells the renderer its project list is stale", async () => {
    const send = vi.fn();
    (
      BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
    ).mockReturnValue([{ webContents: { send } }]);

    await mcpHttpDelete(baseUrl, "/projects/proj-1/workspaces", {
      worktreePath: "/repos/demo-ws",
    });

    expect(send).toHaveBeenCalledWith("projects-changed");
  });

  it("DELETE /projects/:id/workspaces removes a workspace", async () => {
    const result = (await mcpHttpDelete(
      baseUrl,
      "/projects/proj-1/workspaces",
      { worktreePath: "/repos/demo-ws", deleteBranch: true },
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(pm.removeWorktree).toHaveBeenCalledWith(
      "proj-1",
      "/repos/demo-ws",
      true,
    );
  });

  it("returns 503 when project management is unavailable", async () => {
    const bare = new WebviewServer(new Map<string, number>());
    await bare.start();
    const bareUrl = `http://127.0.0.1:${bare.serverPort}`;
    await expect(mcpHttpGet(bareUrl, "/projects")).rejects.toThrow("HTTP 503");
    bare.stop();
  });
});

// ── Agent orchestration routes (issues, /agents, workspaces/batch) ──

describe("WebviewServer agent orchestration routes", () => {
  const PROJECT = {
    id: "proj-1",
    name: "demo",
    path: "/repos/demo",
    defaultBranch: "main",
    workspaces: [
      { path: "/repos/demo", branch: "main", isMain: true, name: null },
    ],
    linearAssociations: [
      { teamId: "team-1", teamName: "Engineering", teamKey: "ENG" },
    ],
  };

  let server: WebviewServer;
  let baseUrl: string;
  let pm: {
    getProjects: ReturnType<typeof vi.fn>;
    addProject: ReturnType<typeof vi.fn>;
    createWorkspacesFromIssues: ReturnType<typeof vi.fn>;
    removeWorktree: ReturnType<typeof vi.fn>;
  };
  let github: {
    getMyIssues: ReturnType<typeof vi.fn>;
    getAllIssues: ReturnType<typeof vi.fn>;
    getIssueDetail: ReturnType<typeof vi.fn>;
    assignIssue: ReturnType<typeof vi.fn>;
  };
  let linearManager: {
    isConnected: ReturnType<typeof vi.fn>;
    getMyIssues: ReturnType<typeof vi.fn>;
    getAllIssues: ReturnType<typeof vi.fn>;
    getIssueDetail: ReturnType<typeof vi.fn>;
  };

  function makeIssueDetail(number: number) {
    return {
      number,
      title: `Issue ${number}`,
      url: `https://github.com/acme/demo/issues/${number}`,
      body: `Body for issue ${number}`,
      state: "open",
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [],
    };
  }

  function makeLinearIssue(identifier: string) {
    return {
      id: `uuid-${identifier}`,
      identifier,
      title: `Linear issue ${identifier}`,
      url: `https://linear.app/acme/issue/${identifier}`,
      branchName: identifier.toLowerCase(),
      priority: 2,
      state: { name: "In Progress", type: "started" },
      labels: [{ name: "bug", color: "#f00" }],
    };
  }

  function makeLinearIssueDetail(identifier: string) {
    return {
      ...makeLinearIssue(identifier),
      description: `Description for ${identifier}`,
      assignee: {
        id: "user-1",
        name: "Ada Lovelace",
        displayName: "Ada Lovelace",
        avatarUrl: null,
      },
    };
  }

  beforeEach(async () => {
    pm = {
      getProjects: vi.fn(async () => [PROJECT]),
      addProject: vi.fn(),
      // The batch route delegates the worktree fan-out to this canonical method
      // (ProjectManager.createWorkspacesFromIssues), which returns the created
      // worktree path per issue.
      createWorkspacesFromIssues: vi.fn(
        async (
          _projectId: string,
          seeds: Array<{
            number: number;
            title: string;
            url: string;
            body?: string | null;
          }>,
        ) =>
          seeds.map((s) => ({
            number: s.number,
            title: s.title,
            body: s.body ?? null,
            url: s.url,
            worktreePath: `/repos/demo-ws-${s.number}`,
          })),
      ),
      removeWorktree: vi.fn(async () => {}),
    };

    github = {
      getMyIssues: vi.fn(async () => [makeIssueDetail(1)]),
      getAllIssues: vi.fn(async () => [makeIssueDetail(2)]),
      getIssueDetail: vi.fn(async (_repoPath: string, number: number) =>
        makeIssueDetail(number),
      ),
      assignIssue: vi.fn(async () => {}),
    };

    linearManager = {
      isConnected: vi.fn(() => true),
      getMyIssues: vi.fn(async () => [makeLinearIssue("ENG-1")]),
      getAllIssues: vi.fn(async () => [makeLinearIssue("ENG-2")]),
      getIssueDetail: vi.fn(async () => makeLinearIssueDetail("ENG-1")),
    };

    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue(
      [],
    );

    server = new WebviewServer(
      new Map<string, number>(),
      pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
      github as unknown as ConstructorParameters<typeof WebviewServer>[2],
      linearManager as unknown as ConstructorParameters<typeof WebviewServer>[3],
    );
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
  });

  describe("GET /projects/:id/issues", () => {
    it("defaults to getMyIssues", async () => {
      const issues = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues",
      )) as unknown[];
      expect(issues).toHaveLength(1);
      expect(github.getMyIssues).toHaveBeenCalledWith(
        "/repos/demo",
        50,
        "open",
      );
      expect(github.getAllIssues).not.toHaveBeenCalled();
    });

    it("filter=all calls getAllIssues", async () => {
      const issues = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues?filter=all",
      )) as unknown[];
      expect(issues).toHaveLength(1);
      expect(github.getAllIssues).toHaveBeenCalledWith(
        "/repos/demo",
        50,
        "open",
      );
      expect(github.getMyIssues).not.toHaveBeenCalled();
    });

    it("returns 503 when no githubManager is configured", async () => {
      const bare = new WebviewServer(
        new Map<string, number>(),
        pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
      );
      await bare.start();
      const bareUrl = `http://127.0.0.1:${bare.serverPort}`;
      await expect(
        mcpHttpGet(bareUrl, "/projects/proj-1/issues"),
      ).rejects.toThrow("HTTP 503");
      bare.stop();
    });

    it("source=github returns the normalized issue shape (existing behavior unchanged)", async () => {
      github.getMyIssues.mockResolvedValueOnce([makeIssueDetail(42)]);
      const issues = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues?source=github",
      )) as unknown[];
      expect(issues).toEqual([
        {
          source: "github",
          ref: "#42",
          title: "Issue 42",
          url: "https://github.com/acme/demo/issues/42",
          state: "open",
          labels: ["bug"],
        },
      ]);
    });

    it("returns 400 for an unknown source", async () => {
      await expect(
        mcpHttpGet(baseUrl, "/projects/proj-1/issues?source=bogus"),
      ).rejects.toThrow("HTTP 400");
    });

    describe("source=linear", () => {
      it("calls getMyIssues with the project's team ids and open-state types", async () => {
        const issues = (await mcpHttpGet(
          baseUrl,
          "/projects/proj-1/issues?source=linear",
        )) as unknown[];
        expect(linearManager.getMyIssues).toHaveBeenCalledWith(["team-1"], {
          stateTypes: ["triage", "backlog", "unstarted", "started"],
          limit: 50,
        });
        expect(linearManager.getAllIssues).not.toHaveBeenCalled();
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

      it("filter=all calls getAllIssues, not getMyIssues", async () => {
        await mcpHttpGet(
          baseUrl,
          "/projects/proj-1/issues?source=linear&filter=all",
        );
        expect(linearManager.getAllIssues).toHaveBeenCalledWith(["team-1"], {
          stateTypes: ["triage", "backlog", "unstarted", "started"],
          limit: 50,
        });
        expect(linearManager.getMyIssues).not.toHaveBeenCalled();
      });

      it("state=closed uses the completed/canceled state types", async () => {
        await mcpHttpGet(
          baseUrl,
          "/projects/proj-1/issues?source=linear&state=closed",
        );
        expect(linearManager.getMyIssues).toHaveBeenCalledWith(["team-1"], {
          stateTypes: ["completed", "canceled"],
          limit: 50,
        });
      });

      it("returns 503 when no linearManager is configured", async () => {
        const bare = new WebviewServer(
          new Map<string, number>(),
          pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
          github as unknown as ConstructorParameters<typeof WebviewServer>[2],
        );
        await bare.start();
        const bareUrl = `http://127.0.0.1:${bare.serverPort}`;
        await expect(
          mcpHttpGet(bareUrl, "/projects/proj-1/issues?source=linear"),
        ).rejects.toThrow("Linear is not connected");
        bare.stop();
      });

      it("returns 503 when linearManager.isConnected() is false", async () => {
        linearManager.isConnected.mockReturnValue(false);
        await expect(
          mcpHttpGet(baseUrl, "/projects/proj-1/issues?source=linear"),
        ).rejects.toThrow("Linear is not connected");
      });

      it("returns 400 (not 503) when the project has no Linear team associated", async () => {
        pm.getProjects.mockResolvedValue([
          { ...PROJECT, linearAssociations: [] },
        ]);
        await expect(
          mcpHttpGet(baseUrl, "/projects/proj-1/issues?source=linear"),
        ).rejects.toThrow("HTTP 400");
        await expect(
          mcpHttpGet(baseUrl, "/projects/proj-1/issues?source=linear"),
        ).rejects.toThrow("no Linear team");
        expect(linearManager.getMyIssues).not.toHaveBeenCalled();
      });

      it("returns 502 when getMyIssues rejects (e.g. expired token)", async () => {
        linearManager.getMyIssues.mockRejectedValueOnce(
          new Error("Linear API error: 401 Unauthorized"),
        );
        await expect(
          mcpHttpGet(baseUrl, "/projects/proj-1/issues?source=linear"),
        ).rejects.toThrow("HTTP 502");
      });
    });

    // GitHubManager used to swallow `gh` failures and return [], so a broken
    // gh looked exactly like an empty backlog. It now rejects, and the route
    // maps that to a 502 the same way it does for Linear.
    it("returns 502 when the GitHub list call rejects (broken gh)", async () => {
      github.getMyIssues.mockRejectedValueOnce(
        new Error("gh: command not found"),
      );
      await expect(
        mcpHttpGet(baseUrl, "/projects/proj-1/issues"),
      ).rejects.toThrow("HTTP 502");
    });
  });

  describe("GET /projects/:id/issues/:issueRef", () => {
    it("source=github with a numeric ref calls getIssueDetail with a number", async () => {
      const detail = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues/42?source=github",
      )) as { source: string; ref: string };
      expect(github.getIssueDetail).toHaveBeenCalledWith("/repos/demo", 42);
      expect(detail).toMatchObject({ source: "github", ref: "#42" });
    });

    // The ref `list_issues` prints is "#42"; percent-encoded it must round-trip
    // to the same issue rather than 400ing on a `parseInt` NaN.
    it("source=github accepts the '#42' ref the listing emitted", async () => {
      const detail = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues/%2342?source=github",
      )) as { source: string; ref: string };
      expect(github.getIssueDetail).toHaveBeenCalledWith("/repos/demo", 42);
      expect(detail).toMatchObject({ source: "github", ref: "#42" });
    });

    it("source=github with a non-numeric ref returns 400 and never calls getIssueDetail", async () => {
      await expect(
        mcpHttpGet(baseUrl, "/projects/proj-1/issues/ENG-1?source=github"),
      ).rejects.toThrow("HTTP 400");
      expect(github.getIssueDetail).not.toHaveBeenCalled();
    });

    it("source=github with a '42abc' ref returns 400, not issue 42", async () => {
      await expect(
        mcpHttpGet(baseUrl, "/projects/proj-1/issues/42abc?source=github"),
      ).rejects.toThrow("HTTP 400");
      expect(github.getIssueDetail).not.toHaveBeenCalled();
    });

    it("source=linear calls linearManager.getIssueDetail and normalizes body from description", async () => {
      const detail = (await mcpHttpGet(
        baseUrl,
        "/projects/proj-1/issues/ENG-1?source=linear",
      )) as { source: string; ref: string; body: string | null };
      expect(linearManager.getIssueDetail).toHaveBeenCalledWith("ENG-1");
      expect(detail).toMatchObject({
        source: "linear",
        ref: "ENG-1",
        body: "Description for ENG-1",
      });
    });

    // A caller's bad ref is a 400 whichever source it named — previously Linear
    // let the SDK throw and the route reported the caller's typo as a 502.
    it("source=linear with a malformed ref returns 400, not 502", async () => {
      await expect(
        mcpHttpGet(baseUrl, "/projects/proj-1/issues/nonsense?source=linear"),
      ).rejects.toThrow("HTTP 400");
      expect(linearManager.getIssueDetail).not.toHaveBeenCalled();
    });
  });

  describe("POST /agents", () => {
    it("dispatches an app-command and returns ok", async () => {
      const send = vi.fn();
      (
        BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
      ).mockReturnValue([{ webContents: { send } }]);

      const result = await mcpHttpPost(baseUrl, "/agents", {
        workspacePath: "/repos/demo-ws",
        prompt: "do the thing",
      });

      expect(result).toEqual({ ok: true });
      expect(send).toHaveBeenCalledWith("app-command", {
        cmd: "start-agent",
        workspacePath: "/repos/demo-ws",
        prompt: "do the thing",
      });
    });

    it("returns 503 when no Manor window is open", async () => {
      (
        BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>
      ).mockReturnValue([]);

      await expect(
        mcpHttpPost(baseUrl, "/agents", { workspacePath: "/repos/demo-ws" }),
      ).rejects.toThrow("HTTP 503");
    });
  });

  describe("POST /projects/:id/workspaces/batch", () => {
    it("creates one workspace per issue and assigns each", async () => {
      const result = (await mcpHttpPost(
        baseUrl,
        "/projects/proj-1/workspaces/batch",
        { issues: [10, 20], assign: true, startAgent: false },
      )) as {
        results: Array<{
          number: number;
          title: string;
          workspacePath?: string;
          started: boolean;
          error?: string;
        }>;
      };

      // The route fans out through the canonical method with pre-fetched seeds.
      expect(pm.createWorkspacesFromIssues).toHaveBeenCalledTimes(1);
      expect(pm.createWorkspacesFromIssues).toHaveBeenCalledWith(
        "proj-1",
        [
          {
            number: 10,
            title: "Issue 10",
            url: "https://github.com/acme/demo/issues/10",
            body: "Body for issue 10",
          },
          {
            number: 20,
            title: "Issue 20",
            url: "https://github.com/acme/demo/issues/20",
            body: "Body for issue 20",
          },
        ],
        undefined,
      );

      expect(github.assignIssue).toHaveBeenCalledWith("/repos/demo", 10);
      expect(github.assignIssue).toHaveBeenCalledWith("/repos/demo", 20);

      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toMatchObject({
        number: 10,
        title: "Issue 10",
        workspacePath: "/repos/demo-ws-10",
        started: false,
      });
      expect(result.results[1]).toMatchObject({
        number: 20,
        title: "Issue 20",
        workspacePath: "/repos/demo-ws-20",
        started: false,
      });
    });

    it("returns the other issue's result when one issue fails", async () => {
      github.getIssueDetail = vi.fn(
        async (_repoPath: string, number: number) => {
          if (number === 20) {
            throw new Error("gh issue view failed");
          }
          return makeIssueDetail(number);
        },
      );

      const result = (await mcpHttpPost(
        baseUrl,
        "/projects/proj-1/workspaces/batch",
        { issues: [10, 20], startAgent: false },
      )) as {
        results: Array<{
          number: number;
          title: string;
          workspacePath?: string;
          started: boolean;
          error?: string;
        }>;
      };

      expect(result.results).toHaveLength(2);
      const ok = result.results.find((r) => r.number === 10);
      const failed = result.results.find((r) => r.number === 20);
      expect(ok).toMatchObject({
        number: 10,
        title: "Issue 10",
        workspacePath: "/repos/demo-ws-10",
        started: false,
      });
      expect(ok?.error).toBeUndefined();
      expect(failed?.error).toContain("gh issue view failed");
      // Only the successfully-fetched issue was fanned out.
      expect(pm.createWorkspacesFromIssues).toHaveBeenCalledTimes(1);
      expect(pm.createWorkspacesFromIssues).toHaveBeenCalledWith(
        "proj-1",
        [
          {
            number: 10,
            title: "Issue 10",
            url: "https://github.com/acme/demo/issues/10",
            body: "Body for issue 10",
          },
        ],
        undefined,
      );
      expect(ok?.workspacePath).toBe("/repos/demo-ws-10");
    });

    it("returns 400 when source: 'linear' is passed in the batch body", async () => {
      await expect(
        mcpHttpPost(baseUrl, "/projects/proj-1/workspaces/batch", {
          source: "linear",
          issues: [10],
        }),
      ).rejects.toThrow("HTTP 400");
      await expect(
        mcpHttpPost(baseUrl, "/projects/proj-1/workspaces/batch", {
          source: "linear",
          issues: [10],
        }),
      ).rejects.toThrow("GitHub issues only");
      expect(pm.createWorkspacesFromIssues).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown source in the batch body", async () => {
      await expect(
        mcpHttpPost(baseUrl, "/projects/proj-1/workspaces/batch", {
          source: "bogus",
          issues: [1],
        }),
      ).rejects.toThrow("HTTP 400");
      await expect(
        mcpHttpPost(baseUrl, "/projects/proj-1/workspaces/batch", {
          source: "bogus",
          issues: [1],
        }),
      ).rejects.toThrow("Unknown source 'bogus'. Use 'github' or 'linear'.");
      expect(pm.createWorkspacesFromIssues).not.toHaveBeenCalled();
    });
  });
});

// ── Pane & tab routes (ADR-149 §4) ──

describe("WebviewServer pane routes", () => {
  let server: WebviewServer;
  let baseUrl: string;
  let send: ReturnType<typeof vi.fn>;

  /**
   * The single "app-command-result" listener `requestRenderer` installs, once,
   * lazily, for the lifetime of the module. Reading it off the `ipcMain` spy
   * (rather than re-exporting it) also proves there is exactly one, no matter
   * how many requests have been made across the whole test file.
   */
  function rendererListener(): (
    event: unknown,
    result: AppCommandResult,
  ) => void {
    const calls = (ipcMain.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === "app-command-result",
    );
    if (calls.length === 0) {
      throw new Error("app-command-result listener was never installed");
    }
    return calls[0][1] as (event: unknown, result: AppCommandResult) => void;
  }

  /**
   * Play the renderer: whenever main sends an "app-command", reply
   * synchronously on "app-command-result" with `{ ok: true, data }`, echoing
   * back the `requestId` main generated. This lets `requestRenderer` resolve
   * within the same HTTP request/response cycle instead of timing out.
   */
  function respondWith(data: unknown): void {
    send.mockImplementation((_channel: string, command: AppCommand) => {
      rendererListener()(null, {
        requestId: command.requestId!,
        ok: true,
        data,
      });
    });
  }

  /** Play a renderer handler that throws. */
  function respondWithError(error: string): void {
    send.mockImplementation((_channel: string, command: AppCommand) => {
      rendererListener()(null, {
        requestId: command.requestId!,
        ok: false,
        error,
      });
    });
  }

  function openWindow(): void {
    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue([
      { webContents: { send } },
    ]);
  }

  beforeEach(async () => {
    send = vi.fn();
    openWindow();
    server = new WebviewServer(new Map<string, number>());
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
    vi.useRealTimers();
  });

  it("GET /panes returns the layout snapshot", async () => {
    respondWith({ workspacePath: "/repos/demo", tabs: [] });

    const result = await mcpHttpGet(baseUrl, "/panes");

    expect(result).toEqual({ workspacePath: "/repos/demo", tabs: [] });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "list-panes",
      requestId: expect.any(String),
    });
  });

  it("POST /panes/split returns the new paneId", async () => {
    respondWith({ paneId: "pane-2" });

    const result = await mcpHttpPost(baseUrl, "/panes/split", {
      paneId: "pane-1",
      direction: "horizontal",
      contentType: "browser",
      url: "https://example.com",
    });

    expect(result).toEqual({ paneId: "pane-2" });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "split-pane",
      requestId: expect.any(String),
      args: {
        paneId: "pane-1",
        direction: "horizontal",
        contentType: "browser",
        url: "https://example.com",
      },
    });
  });

  it("POST /panes/:paneId/focus focuses the pane", async () => {
    respondWith({ ok: true });

    const result = await mcpHttpPost(baseUrl, "/panes/pane-1/focus");

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "focus-pane",
      requestId: expect.any(String),
      args: { paneId: "pane-1" },
    });
  });

  it("DELETE /panes/:paneId closes the pane", async () => {
    respondWith({ ok: true });

    const result = await mcpHttpDelete(baseUrl, "/panes/pane-1");

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "close-pane",
      requestId: expect.any(String),
      args: { paneId: "pane-1" },
    });
  });

  it("POST /tabs creates a new terminal tab", async () => {
    respondWith({ tabId: "tab-1", paneId: "pane-1" });

    const result = await mcpHttpPost(baseUrl, "/tabs", {
      contentType: "terminal",
    });

    expect(result).toEqual({ tabId: "tab-1", paneId: "pane-1" });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "new-tab",
      requestId: expect.any(String),
      args: { contentType: "terminal" },
    });
  });

  it("POST /tabs creates a new browser tab given a url", async () => {
    respondWith({ tabId: "tab-2", paneId: "pane-2" });

    const result = await mcpHttpPost(baseUrl, "/tabs", {
      contentType: "browser",
      url: "https://example.com",
    });

    expect(result).toEqual({ tabId: "tab-2", paneId: "pane-2" });
    expect(send).toHaveBeenCalledWith("app-command", {
      cmd: "new-tab",
      requestId: expect.any(String),
      args: { contentType: "browser", url: "https://example.com" },
    });
  });

  it("returns 400 when a renderer handler throws", async () => {
    respondWithError("Unknown paneId: pane-404");

    await expect(
      mcpHttpDelete(baseUrl, "/panes/pane-404"),
    ).rejects.toThrow("HTTP 400");
  });

  it("returns 405 for GET /tabs", async () => {
    await expect(mcpHttpGet(baseUrl, "/tabs")).rejects.toThrow("HTTP 405");
  });

  it("returns 405 for an unsupported method on /panes", async () => {
    await expect(mcpHttpPost(baseUrl, "/panes")).rejects.toThrow("HTTP 405");
  });

  it("returns 503 when no Manor window is open", async () => {
    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue(
      [],
    );

    await expect(mcpHttpGet(baseUrl, "/panes")).rejects.toThrow("HTTP 503");
  });

  it(
    "returns 503 on renderer timeout",
    async () => {
      // `send` never replies — the renderer is unresponsive. This exercises
      // the real (5s) `requestRenderer` timeout end-to-end over HTTP; faking
      // timers here would also have to fake the real socket I/O `fetch`
      // depends on, which the `requestRenderer` describe block below already
      // covers directly and more precisely.
      await expect(mcpHttpGet(baseUrl, "/panes")).rejects.toThrow("HTTP 503");
    },
    7000,
  );
});

// ── Correlated main→renderer request/response (ADR-149 §1) ──

describe("requestRenderer", () => {
  let send: ReturnType<typeof vi.fn>;

  /**
   * The single "app-command-result" listener renderer-bridge installs lazily.
   * Read off the ipcMain spy rather than re-exported, so the test also proves
   * exactly one listener exists no matter how many requests are in flight.
   */
  function rendererListener(): (
    event: unknown,
    result: AppCommandResult,
  ) => void {
    const calls = (ipcMain.on as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === "app-command-result",
    );
    if (calls.length === 0) {
      throw new Error("app-command-result listener was never installed");
    }
    expect(calls).toHaveLength(1);
    return calls[0][1] as (event: unknown, result: AppCommandResult) => void;
  }

  /** Play the renderer: reply on the captured listener. */
  function reply(result: AppCommandResult): void {
    rendererListener()(null, result);
  }

  /** The nth AppCommand handed to `webContents.send`. */
  function sentCommand(index = 0): AppCommand {
    return send.mock.calls[index][1] as AppCommand;
  }

  function openWindow(): void {
    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue([
      { webContents: { send } },
    ]);
  }

  beforeEach(() => {
    send = vi.fn();
    openWindow();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the renderer's data when the ids match", async () => {
    const pending = requestRenderer("split-pane", {
      direction: "horizontal",
    });

    const command = sentCommand();
    expect(command.cmd).toBe("split-pane");
    expect(command.args).toEqual({ direction: "horizontal" });
    expect(typeof command.requestId).toBe("string");

    reply({ requestId: command.requestId!, ok: true, data: { paneId: "pane-1" } });

    await expect(pending).resolves.toEqual({
      ok: true,
      data: { paneId: "pane-1" },
    });
  });

  it("propagates a handler error as ok:false", async () => {
    const pending = requestRenderer("close-pane", { paneId: "nope" });
    reply({
      requestId: sentCommand().requestId!,
      ok: false,
      error: "No such pane",
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      kind: "handler",
      error: "No such pane",
    });
  });

  it("omits args when none are given", async () => {
    const pending = requestRenderer("list-panes");
    const command = sentCommand();
    expect(command).not.toHaveProperty("args");
    reply({ requestId: command.requestId!, ok: true, data: { tabs: [] } });
    await pending;
  });

  it("resolves ok:false when no Manor window is open", async () => {
    (BrowserWindow.getAllWindows as ReturnType<typeof vi.fn>).mockReturnValue(
      [],
    );
    await expect(requestRenderer("list-panes")).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      error: "No Manor window is open",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves ok:false when the renderer never replies", async () => {
    vi.useFakeTimers();
    const pending = requestRenderer("list-panes", undefined, 5000);
    vi.advanceTimersByTime(5000);
    await expect(pending).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      error: "Renderer did not respond",
    });
  });

  it("ignores a reply with an unknown requestId", async () => {
    const pending = requestRenderer("list-panes");
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    expect(() => reply({ requestId: "not-a-real-id", ok: true })).not.toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);

    // The real reply still lands.
    reply({ requestId: sentCommand().requestId!, ok: true, data: "late" });
    await expect(pending).resolves.toEqual({ ok: true, data: "late" });
  });

  it("resolves concurrent requests independently, in reply order", async () => {
    const first = requestRenderer("list-panes");
    const second = requestRenderer("focus-pane", { paneId: "p2" });

    const firstId = sentCommand(0).requestId!;
    const secondId = sentCommand(1).requestId!;
    expect(firstId).not.toBe(secondId);

    // Reply out of order — each promise must pick up its own payload.
    reply({ requestId: secondId, ok: true, data: "second" });
    reply({ requestId: firstId, ok: true, data: "first" });

    await expect(first).resolves.toEqual({ ok: true, data: "first" });
    await expect(second).resolves.toEqual({ ok: true, data: "second" });
  });

  it("leaves no entry behind after a timeout", async () => {
    vi.useFakeTimers();

    const timedOut = requestRenderer("list-panes", undefined, 1000);
    vi.advanceTimersByTime(1000);
    await expect(timedOut).resolves.toEqual({
      ok: false,
      kind: "unavailable",
      error: "Renderer did not respond",
    });

    // A late reply for the abandoned request must not throw or double-resolve.
    const staleId = sentCommand(0).requestId!;
    expect(() => reply({ requestId: staleId, ok: true, data: 1 })).not.toThrow();

    // A subsequent request still works — the map is not wedged.
    const next = requestRenderer("list-panes", undefined, 1000);
    reply({ requestId: sentCommand(1).requestId!, ok: true, data: "ok" });
    await expect(next).resolves.toEqual({ ok: true, data: "ok" });
  });
});

// ── TOOLS/handlers parity test (ADR-149) ──

describe("MCP tools composition and parity", () => {
  it("composes exactly 28 tools with matching handlers", () => {
    // Compose the modules the same way mcp-webview-server.ts does
    // (we import directly rather than from mcp-webview-server.ts because
    // that module calls main() at load time).
    const modules = [webviewModule, projectsModule, agentsModule, panesModule];
    const tools = modules.flatMap((m) => m.tools);
    const handlers = Object.assign({}, ...modules.map((m) => m.handlers));

    // Assert the total tool count: 11 webview + 7 projects + 4 agents + 6 pane tools = 28
    // (projects gained `current_workspace` in ADR-150.)
    const toolNames = tools.map((t) => t.name);
    expect(tools).toHaveLength(28);

    // Assert the six new pane tools are present
    const newPaneTools = ["list_panes", "split_pane", "new_terminal", "new_browser", "focus_pane", "close_pane"];
    for (const toolName of newPaneTools) {
      expect(toolNames).toContain(toolName);
    }

    // Assert TOOLS/handlers parity: every tool has a handler, and vice versa
    const toolNameSet = new Set(toolNames);
    const handlerNameSet = new Set(Object.keys(handlers));

    expect(toolNameSet.size).toBe(handlerNameSet.size);
    for (const toolName of toolNameSet) {
      expect(handlerNameSet).toContain(toolName);
    }
    for (const handlerName of handlerNameSet) {
      expect(toolNameSet).toContain(handlerName);
    }
  });
});

// ── GET /context (ADR-150) ──
//
// Ticket 1 (pane-context.test.ts) already unit-tests the pure resolver.
// These tests are about routing, the resolution ladder, dep-guards, and the
// `sources` computation — driven end to end over HTTP against a real
// WebviewServer, the same pattern the rest of this file uses.

/** Raw fetch for /context — unlike mcpHttpGet/mcpHttpPost, this doesn't throw
 * on non-2xx, so tests can assert on the 404 body's `candidates`, etc. */
async function getContext(
  baseUrl: string,
  query: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/context${query}`);
  const body = await res.json();
  return { status: res.status, body };
}

function paneSession(): PersistedPaneSession {
  return { daemonSessionId: "daemon-1", lastCwd: null, lastTitle: null };
}

function contextTab(
  id: string,
  paneSessions: Record<string, PersistedPaneSession>,
): PersistedTab {
  const firstPaneId = Object.keys(paneSessions)[0] ?? "pane-x";
  return {
    id,
    title: id,
    rootNode: { type: "leaf", paneId: firstPaneId },
    focusedPaneId: firstPaneId,
    paneSessions,
  };
}

function contextPanel(id: string, tabs: PersistedTab[]): PersistedPanel {
  return { id, tabs, selectedTabId: tabs[0]?.id ?? "", pinnedTabIds: [] };
}

function contextWorkspace(
  workspacePath: string,
  panels: Record<string, PersistedPanel>,
): PersistedWorkspace {
  const firstPanelId = Object.keys(panels)[0] ?? "panel-1";
  return {
    workspacePath,
    panelTree: { type: "leaf", panelId: firstPanelId },
    panels,
    activePanelId: firstPanelId,
  };
}

// A pane buried in a non-first workspace, a non-first panel, and a non-first
// tab — a naive "check the first hit" implementation would resolve the wrong
// workspace (or nothing) here.
const CONTEXT_LAYOUT_FIXTURE: PersistedLayout = {
  version: 2,
  workspaces: [
    contextWorkspace("/unrelated/project", {
      "panel-a": contextPanel("panel-a", [
        contextTab("tab-a", { "pane-other": paneSession() }),
      ]),
    }),
    contextWorkspace("/repo/.worktrees/feat", {
      "panel-1": contextPanel("panel-1", [
        contextTab("tab-1", { "pane-1": paneSession() }),
      ]),
      "panel-2": contextPanel("panel-2", [
        contextTab("tab-2", { "pane-2": paneSession() }),
        contextTab("tab-3", { "pane-target": paneSession() }),
      ]),
    }),
  ],
};

const CONTEXT_MAIN_WORKSPACE = {
  path: "/repo",
  branch: "main",
  isMain: true,
  name: null,
};
const CONTEXT_WORKTREE_WORKSPACE = {
  path: "/repo/.worktrees/feat",
  branch: "feat",
  isMain: false,
  name: "feat",
};

// Main workspace and a worktree nested beneath it, so longest-prefix
// matching is actually exercised end to end through the route.
const CONTEXT_PROJECT = {
  id: "proj-1",
  name: "demo",
  path: "/repo",
  defaultBranch: "main",
  workspaces: [CONTEXT_MAIN_WORKSPACE, CONTEXT_WORKTREE_WORKSPACE],
  linearAssociations: [
    { teamId: "team-1", teamName: "Engineering", teamKey: "ENG" },
  ],
};

describe("GET /context", () => {
  let server: WebviewServer;
  let baseUrl: string;
  let pm: { getProjects: ReturnType<typeof vi.fn> };
  let github: Record<string, unknown>;
  let linearManager: { isConnected: ReturnType<typeof vi.fn> };
  let layoutPersistence: { load: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    pm = { getProjects: vi.fn(async () => [CONTEXT_PROJECT]) };
    github = {};
    linearManager = { isConnected: vi.fn(() => true) };
    layoutPersistence = { load: vi.fn(() => CONTEXT_LAYOUT_FIXTURE) };

    server = new WebviewServer(
      new Map<string, number>(),
      pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
      github as unknown as ConstructorParameters<typeof WebviewServer>[2],
      linearManager as unknown as ConstructorParameters<typeof WebviewServer>[3],
      layoutPersistence as unknown as ConstructorParameters<typeof WebviewServer>[4],
    );
    await server.start();
    baseUrl = `http://127.0.0.1:${server.serverPort}`;
  });

  afterEach(() => {
    server.stop();
  });

  it("resolves via the paneId rung", async () => {
    const { status, body } = await getContext(baseUrl, "?paneId=pane-target");

    expect(status).toBe(200);
    expect(body).toMatchObject({
      projectId: "proj-1",
      workspacePath: "/repo/.worktrees/feat",
    });
    expect(layoutPersistence.load).toHaveBeenCalled();
  });

  it("resolves via the cwd rung, matching the worktree over the main workspace", async () => {
    const { status, body } = await getContext(
      baseUrl,
      `?cwd=${encodeURIComponent("/repo/.worktrees/feat/src")}`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      projectId: "proj-1",
      workspacePath: "/repo/.worktrees/feat",
    });
    // No `paneId` param, so the paneId rung never runs.
    expect(layoutPersistence.load).not.toHaveBeenCalled();
  });

  it("paneId wins over cwd when both are present and point at different workspaces", async () => {
    const { status, body } = await getContext(
      baseUrl,
      `?paneId=pane-target&cwd=${encodeURIComponent("/repo")}`,
    );

    expect(status).toBe(200);
    // Had `cwd` won, `workspacePath` would be "/repo" — the fixture's cwd
    // target — not the worktree the paneId points at.
    expect(body).toMatchObject({ workspacePath: "/repo/.worktrees/feat" });
    expect(layoutPersistence.load).toHaveBeenCalled();
  });

  it("falls through to cwd when paneId is absent from the layout (debounce lag), not a 404", async () => {
    const { status, body } = await getContext(
      baseUrl,
      `?paneId=pane-not-in-layout&cwd=${encodeURIComponent("/repo")}`,
    );

    expect(status).toBe(200);
    // The paneId rung ran (it consulted the layout) but missed, so cwd's
    // "/repo" — not the fixture's worktree — is what came back.
    expect(body).toMatchObject({ workspacePath: "/repo" });
    expect(layoutPersistence.load).toHaveBeenCalled();
  });

  it("falls through to cwd when the layout is corrupt (load returns null), not a 500", async () => {
    layoutPersistence.load.mockReturnValue(null);

    const { status, body } = await getContext(
      baseUrl,
      `?paneId=pane-target&cwd=${encodeURIComponent("/repo")}`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ workspacePath: "/repo" });
    expect(layoutPersistence.load).toHaveBeenCalled();
  });

  it("resolves via cwd when no layoutPersistence is configured at all", async () => {
    const bare = new WebviewServer(
      new Map<string, number>(),
      pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
    );
    await bare.start();
    const bareUrl = `http://127.0.0.1:${bare.serverPort}`;

    // paneId is present too, to prove the optional-chained
    // `deps.layoutPersistence?.load()` doesn't throw when the dep is null.
    const { status, body } = await getContext(
      bareUrl,
      `?paneId=pane-target&cwd=${encodeURIComponent("/repo")}`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ workspacePath: "/repo" });
    bare.stop();
  });

  it("404s with non-empty candidates when neither param resolves", async () => {
    const { status, body } = await getContext(baseUrl, "?cwd=/nowhere");

    expect(status).toBe(404);
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.candidates)).toBe(true);
    const candidates = body.candidates as unknown[];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]).toMatchObject({
      projectId: "proj-1",
      name: "demo",
      path: "/repo",
    });
  });

  it("returns 405 for POST /context", async () => {
    await expect(mcpHttpPost(baseUrl, "/context")).rejects.toThrow(
      "HTTP 405",
    );
  });

  it("returns 503 when there is no projectManager", async () => {
    const bare = new WebviewServer(new Map<string, number>());
    await bare.start();
    const bareUrl = `http://127.0.0.1:${bare.serverPort}`;

    await expect(
      mcpHttpGet(bareUrl, "/context?cwd=/repo"),
    ).rejects.toThrow("HTTP 503");
    bare.stop();
  });
});

describe("GET /context sources computation", () => {
  /** Spin up a WebviewServer with the given manager combination, resolvable
   * via `cwd=/repo` against a project with the given linearAssociations. */
  async function serverWithSources(
    githubManager: ConstructorParameters<typeof WebviewServer>[2] | undefined,
    linearManager: ConstructorParameters<typeof WebviewServer>[3] | undefined,
    linearAssociations: Array<{
      teamId: string;
      teamName: string;
      teamKey: string;
    }>,
  ): Promise<{ server: WebviewServer; baseUrl: string }> {
    const pm = {
      getProjects: vi.fn(async () => [
        { ...CONTEXT_PROJECT, linearAssociations },
      ]),
    };
    const server = new WebviewServer(
      new Map<string, number>(),
      pm as unknown as ConstructorParameters<typeof WebviewServer>[1],
      githubManager,
      linearManager,
    );
    await server.start();
    return { server, baseUrl: `http://127.0.0.1:${server.serverPort}` };
  }

  const GITHUB_STUB = {} as unknown as ConstructorParameters<
    typeof WebviewServer
  >[2];

  it("github present, linear connected, project has associations -> [github, linear]", async () => {
    const linear = {
      isConnected: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof WebviewServer>[3];
    const { server, baseUrl } = await serverWithSources(GITHUB_STUB, linear, [
      { teamId: "team-1", teamName: "Engineering", teamKey: "ENG" },
    ]);

    const { body } = await getContext(baseUrl, "?cwd=/repo");
    expect(body.sources).toEqual(["github", "linear"]);

    server.stop();
  });

  it("linear connected but linearAssociations is empty -> [github] only", async () => {
    const linear = {
      isConnected: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof WebviewServer>[3];
    const { server, baseUrl } = await serverWithSources(GITHUB_STUB, linear, []);

    const { body } = await getContext(baseUrl, "?cwd=/repo");
    expect(body.sources).toEqual(["github"]);

    server.stop();
  });

  it("linearManager.isConnected() is false, associations present -> [github] only", async () => {
    const linear = {
      isConnected: vi.fn(() => false),
    } as unknown as ConstructorParameters<typeof WebviewServer>[3];
    const { server, baseUrl } = await serverWithSources(GITHUB_STUB, linear, [
      { teamId: "team-1", teamName: "Engineering", teamKey: "ENG" },
    ]);

    const { body } = await getContext(baseUrl, "?cwd=/repo");
    expect(body.sources).toEqual(["github"]);

    server.stop();
  });

  it("no githubManager, linear fully configured -> [linear] only", async () => {
    const linear = {
      isConnected: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof WebviewServer>[3];
    const { server, baseUrl } = await serverWithSources(undefined, linear, [
      { teamId: "team-1", teamName: "Engineering", teamKey: "ENG" },
    ]);

    const { body } = await getContext(baseUrl, "?cwd=/repo");
    expect(body.sources).toEqual(["linear"]);

    server.stop();
  });

  it("neither github nor linear -> []", async () => {
    const { server, baseUrl } = await serverWithSources(
      undefined,
      undefined,
      [],
    );

    const { body } = await getContext(baseUrl, "?cwd=/repo");
    expect(body.sources).toEqual([]);

    server.stop();
  });
});
