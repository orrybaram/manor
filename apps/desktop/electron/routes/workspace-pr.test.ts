/**
 * `/projects/:projectId/workspaces/pr/*` — `manor merge-pr`, `fix-pr-checks`
 * and `address-pr-comments`: the merge method is the repo's to allow, the
 * workspace goes only once its PR has merged, and a brief is printed, typed
 * into a waiting agent, or handed to a new one.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const startAgentInWorkspace = vi.hoisted(() => vi.fn());
vi.mock("./agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents")>()),
  startAgentInWorkspace,
}));

import { workspacePrRoutes } from "./workspace-pr";
import type { ServerRoute, ServerRouteDeps } from "./types";
import type { PrMergeOptions } from "../../src/lib/pr-info";

const MAIN = "/repo";
const FEATURE = "/repo/worktrees/feature";

const project = {
  id: "p1",
  name: "Repo",
  path: MAIN,
  hostId: "local",
  defaultBranch: "main",
  folders: [],
  workspaces: [
    { path: MAIN, branch: "main", isMain: true, name: null },
    { path: FEATURE, branch: "feature", isMain: false, name: null },
  ],
};

const openPr = { number: 12, state: "open", title: "Feature", url: "https://github.com/o/r/pull/12" };

function route(path: string): ServerRoute {
  const found = workspacePrRoutes.find(
    (r) => r.path === `/projects/:projectId/workspaces/pr/${path}`,
  );
  if (!found) throw new Error(`No route ${path}`);
  return found;
}

interface Agent {
  id: string;
  name: string | null;
  status: string;
  lastAgentStatus: string | null;
  paneId: string | null;
  workspacePath: string | null;
  agentKind: "claude";
  updatedAt: string;
}

function agent(over: Partial<Agent>): Agent {
  return {
    id: "a1",
    name: "fixer",
    status: "active",
    lastAgentStatus: "idle",
    paneId: "pane-1",
    workspacePath: FEATURE,
    agentKind: "claude",
    updatedAt: "2026-10-30T10:00:00Z",
    ...over,
  };
}

let mergeOptions: PrMergeOptions;
let pr: typeof openPr | null;
let agents: Agent[];
let livePanes: Set<string>;
const github = {
  getPrForBranch: vi.fn(async () => pr),
  getMergeOptions: vi.fn(async () => mergeOptions),
  mergePr: vi.fn(async (): Promise<string> => "merged"),
  getPrAgentPrompt: vi.fn(async () => "Fix the failing checks."),
};
const remove = vi.fn(async () => {});
const ptyWrite = vi.fn();

function deps(): ServerRouteDeps {
  return {
    projectManager: { getProjects: async () => [project] },
    githubManager: github,
    workspaceOps: { remove },
    agentManager: { getActiveAgents: () => agents },
    layoutStore: { workspaceOf: (paneId: string) => (livePanes.has(paneId) ? FEATURE : null) },
    chatMirror: {
      input: () => ({ promptWrites: (text: string) => [text, "\r"], interruptKeys: ["\x1b"] }),
    },
    backend: { pty: { write: ptyWrite } },
  } as unknown as ServerRouteDeps;
}

async function call(path: string, body: Record<string, unknown>) {
  const r = route(path);
  const answers: Array<{ status: number; body: unknown }> = [];
  await r.handler({
    method: r.method,
    deps: deps(),
    params: { projectId: "p1" },
    url: new URL(`http://localhost/projects/p1/workspaces/pr/${path}`),
    json: (status, answer) => answers.push({ status, body: answer }),
    readBody: async () => body,
  });
  expect(answers).toHaveLength(1);
  return answers[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mergeOptions = { allowed: ["squash", "merge"], autoMergeAllowed: true, mergeQueue: false };
  pr = { ...openPr };
  agents = [];
  livePanes = new Set(["pane-1", "pane-2"]);
  github.mergePr.mockResolvedValue("merged");
});

describe("POST …/pr/merge", () => {
  it("merges with the repo's default method when none is named", async () => {
    const answer = await call("merge", { workspacePath: FEATURE });
    expect(github.getPrForBranch).toHaveBeenCalledWith({ path: MAIN, hostId: "local" }, "feature");
    expect(github.getMergeOptions).toHaveBeenCalledWith({ path: MAIN, hostId: "local" }, 12);
    expect(github.mergePr).toHaveBeenCalledWith(
      { path: MAIN, hostId: "local" },
      12,
      "squash",
      false,
    );
    expect(answer).toEqual({
      status: 200,
      body: expect.objectContaining({ number: 12, method: "squash", outcome: "merged", removedWorkspace: null }),
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses a method the repo doesn't allow, before asking gh to merge", async () => {
    const answer = await call("merge", { workspacePath: FEATURE, method: "rebase" });
    expect(answer.status).toBe(400);
    expect(String((answer.body as { error: string }).error)).toContain("doesn't allow rebase");
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("refuses a method that isn't one", async () => {
    const answer = await call("merge", { workspacePath: FEATURE, method: "octopus" });
    expect(answer.status).toBe(400);
    expect(github.getPrForBranch).not.toHaveBeenCalled();
  });

  it("refuses auto-merge on a repo that has it off, unless the base has a merge queue", async () => {
    mergeOptions = { ...mergeOptions, autoMergeAllowed: false };
    expect((await call("merge", { workspacePath: FEATURE, auto: true })).status).toBe(400);
    expect(github.mergePr).not.toHaveBeenCalled();

    mergeOptions = { ...mergeOptions, mergeQueue: true };
    github.mergePr.mockResolvedValue("queued");
    const queued = await call("merge", { workspacePath: FEATURE, auto: true });
    expect(queued.body).toMatchObject({ outcome: "queued" });
  });

  it("removes the workspace and its branch after a merge that happened now", async () => {
    const answer = await call("merge", { workspacePath: FEATURE, deleteWorkspace: true });
    expect(remove).toHaveBeenCalledWith("p1", FEATURE, true);
    expect(answer.body).toMatchObject({ outcome: "merged", removedWorkspace: FEATURE });
  });

  it.each(["auto", "queued"])("keeps the workspace when the PR is %s rather than merged", async (outcome) => {
    github.mergePr.mockResolvedValue(outcome);
    const answer = await call("merge", { workspacePath: FEATURE, deleteWorkspace: true, auto: outcome === "auto" });
    expect(remove).not.toHaveBeenCalled();
    expect(answer.body).toMatchObject({ outcome, removedWorkspace: null });
  });

  it("keeps the workspace when gh refuses the merge", async () => {
    github.mergePr.mockRejectedValueOnce(new Error("Pull request is not mergeable"));
    const answer = await call("merge", { workspacePath: FEATURE, deleteWorkspace: true });
    expect(answer).toEqual({ status: 502, body: { error: "Pull request is not mergeable" } });
    expect(remove).not.toHaveBeenCalled();
  });

  it("never removes the project's main workspace", async () => {
    const answer = await call("merge", { workspacePath: MAIN, deleteWorkspace: true });
    expect(answer.status).toBe(400);
    expect(github.mergePr).not.toHaveBeenCalled();
  });

  it("says so when the branch has no open PR", async () => {
    pr = null;
    expect((await call("merge", { workspacePath: FEATURE })).status).toBe(404);
    pr = { ...openPr, state: "merged" };
    expect(await call("merge", { workspacePath: FEATURE })).toEqual({
      status: 409,
      body: { error: "PR #12 is merged, not open" },
    });
    expect(github.mergePr).not.toHaveBeenCalled();
  });
});

describe("POST …/pr/fix-checks and …/pr/address-comments", () => {
  it("with print, only answers the brief", async () => {
    agents = [agent({})];
    const answer = await call("fix-checks", { workspacePath: FEATURE, print: true });
    expect(github.getPrAgentPrompt).toHaveBeenCalledWith({ path: MAIN, hostId: "local" }, 12, "checks");
    expect(answer).toEqual({
      status: 200,
      body: { delivery: "printed", number: 12, prompt: "Fix the failing checks." },
    });
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(startAgentInWorkspace).not.toHaveBeenCalled();
  });

  it("types the brief into the workspace's most recent waiting agent", async () => {
    agents = [
      agent({ id: "old", paneId: "pane-1", updatedAt: "2026-10-30T09:00:00Z" }),
      agent({ id: "new", name: "reviewer", paneId: "pane-2", lastAgentStatus: "responded" }),
      agent({ id: "busy", paneId: "pane-3", lastAgentStatus: "thinking", updatedAt: "2026-10-30T11:00:00Z" }),
      agent({ id: "elsewhere", workspacePath: MAIN, updatedAt: "2026-10-30T12:00:00Z" }),
    ];
    const answer = await call("address-comments", { workspacePath: FEATURE });
    expect(github.getPrAgentPrompt).toHaveBeenCalledWith(expect.anything(), 12, "comments");
    expect(answer.body).toEqual({
      delivery: "sent",
      number: 12,
      agentId: "new",
      agentName: "reviewer",
      paneId: "pane-2",
    });
    expect(ptyWrite).toHaveBeenNthCalledWith(1, "pane-2", "Fix the failing checks.");
    expect(ptyWrite).toHaveBeenNthCalledWith(2, "pane-2", "\r");
    expect(startAgentInWorkspace).not.toHaveBeenCalled();
  });

  it("starts a new agent with the brief when none there is waiting", async () => {
    agents = [
      agent({ lastAgentStatus: "thinking" }),
      // Waiting, but its pane is gone.
      agent({ id: "gone", paneId: "pane-9" }),
    ];
    startAgentInWorkspace.mockResolvedValue({
      ok: true,
      data: { tabId: "tab-1", paneId: "pane-new", workspacePath: FEATURE },
    });
    const answer = await call("fix-checks", { workspacePath: FEATURE });
    expect(startAgentInWorkspace).toHaveBeenCalledWith(expect.anything(), FEATURE, {
      prompt: "Fix the failing checks.",
      hostId: "local",
    });
    expect(answer.body).toEqual({ delivery: "started", number: 12, paneId: "pane-new", tabId: "tab-1" });
    expect(ptyWrite).not.toHaveBeenCalled();
  });

  it("answers 409 when the PR has nothing for the task, starting nothing", async () => {
    github.getPrAgentPrompt.mockRejectedValueOnce(new Error("PR #12 has no failing checks"));
    const answer = await call("fix-checks", { workspacePath: FEATURE });
    expect(answer).toEqual({ status: 409, body: { error: "PR #12 has no failing checks" } });
    expect(startAgentInWorkspace).not.toHaveBeenCalled();
  });
});
