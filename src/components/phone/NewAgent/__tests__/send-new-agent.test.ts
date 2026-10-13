/**
 * ADR-222 D6: the composer's send. An existing workspace launches at once; a
 * new worktree is named from the prompt, branched off the chosen workspace,
 * and keeps the draft when creation fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listLocalBranches = vi.hoisted(() => vi.fn());
vi.hoisted(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    claim: null,
    projects: { listLocalBranches },
  };
});

const launchAgentInWorkspace = vi.hoisted(() => vi.fn());
const markChatStarting = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/agent-prompt-launch", () => ({ launchAgentInWorkspace }));
vi.mock("../../ChatPane/usePaneChatView", () => ({ markChatStarting }));

import type { ProjectInfo } from "../../../../store/project-store";
import { useProjectStore } from "../../../../store/project-store";
import { useAppStore } from "../../../../store/app-store";
import { sendNewAgent } from "../send-new-agent";

const solo = {
  id: "solo",
  name: "solo",
  path: "/code/solo",
  hostId: "local",
  defaultBranch: "main",
  agentCommand: null,
  color: null,
  folders: [],
  sidebarOrder: [],
  group: null,
  workspaces: [
    { path: "/code/solo", branch: "develop", isMain: true, name: null },
    { path: "/wt/feat", branch: "feat", isMain: false, name: "fix-login" },
    { path: "/wt/detached", branch: "", isMain: false, name: "detached" },
  ],
} as unknown as ProjectInfo;

const createWorktree = vi.fn();

/** Let the worktree send's branch listing and creation settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  listLocalBranches.mockResolvedValue([]);
  useProjectStore.setState({ projects: [solo], createWorktree });
  useAppStore.setState({
    activeSurface: "composer",
    composerDraft: { text: "fix the login bug", target: null },
  });
});

describe("sendNewAgent", () => {
  it("launches in an existing workspace and clears the draft", () => {
    launchAgentInWorkspace.mockReturnValue({ tabId: "t", paneId: "p1" });
    sendNewAgent("fix the login bug\n", { projectId: "solo", workspacePath: "/wt/feat", newWorktree: false });

    expect(launchAgentInWorkspace).toHaveBeenCalledWith("/wt/feat", {
      prompt: "fix the login bug",
      hostId: "local",
    });
    expect(markChatStarting).toHaveBeenCalledWith("p1");
    expect(useAppStore.getState().composerDraft.text).toBe("");
  });

  it("keeps the composer and its draft when no tab opened", () => {
    launchAgentInWorkspace.mockReturnValue(null);
    sendNewAgent("fix the login bug", { projectId: "solo", workspacePath: "/wt/feat", newWorktree: false });

    expect(useAppStore.getState().activeSurface).toBe("composer");
    expect(useAppStore.getState().composerDraft.text).toBe("fix the login bug");
  });

  it("names a new worktree from the prompt, off the chosen workspace's branch", async () => {
    createWorktree.mockImplementation(async (_id, _name, opts) => {
      opts.onAgentPane("p2");
      return "/wt/fix-login-2";
    });
    sendNewAgent("fix login", { projectId: "solo", workspacePath: "/wt/feat", newWorktree: true });
    expect(useAppStore.getState().activeSurface).toBe("workspace");
    await settle();

    expect(createWorktree).toHaveBeenCalledWith("solo", "fix-login-2", {
      baseBranch: "feat",
      agentPrompt: "fix login",
      onAgentPane: expect.any(Function),
    });
    expect(markChatStarting).toHaveBeenCalledWith("p2");
    expect(useAppStore.getState().composerDraft.text).toBe("");
  });

  it("skips a local branch with no worktree, whatever its case", async () => {
    listLocalBranches.mockResolvedValue(["Fix-The-Login-Bug"]);
    createWorktree.mockResolvedValue("/wt/x");
    sendNewAgent("fix the login bug", { projectId: "solo", workspacePath: "/code/solo", newWorktree: true });
    await settle();

    expect(createWorktree.mock.calls[0][1]).toBe("fix-the-login-bug-2");
  });

  it("names from the worktrees alone when the branch listing fails", async () => {
    listLocalBranches.mockRejectedValue(new Error("offline"));
    createWorktree.mockResolvedValue("/wt/x");
    sendNewAgent("fix login", { projectId: "solo", workspacePath: "/code/solo", newWorktree: true });
    await settle();

    expect(createWorktree.mock.calls[0][1]).toBe("fix-login-2");
  });

  it("branches main's worktree off the default branch, and keeps the draft on failure", async () => {
    createWorktree.mockResolvedValue(null);
    sendNewAgent("fix the login bug", { projectId: "solo", workspacePath: "/code/solo", newWorktree: true });
    await settle();

    expect(createWorktree.mock.calls[0][2].baseBranch).toBe("main");
    expect(useAppStore.getState().composerDraft.text).toBe("fix the login bug");
  });

  it("leaves a detached workspace's base to the default", async () => {
    createWorktree.mockResolvedValue("/wt/x");
    sendNewAgent("fix it", { projectId: "solo", workspacePath: "/wt/detached", newWorktree: true });
    await settle();

    expect(createWorktree.mock.calls[0][2].baseBranch).toBeUndefined();
  });
});
