// @vitest-environment jsdom
/**
 * ADR-222 D6: the composer's send. An existing workspace launches at once; a
 * new worktree is named from the prompt, branched off the chosen workspace,
 * and keeps the draft when creation fails.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (window as unknown as { electronAPI: unknown }).electronAPI = { claim: null };
});

const launchAgentInWorkspace = vi.hoisted(() => vi.fn());
const markChatStarting = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/agent-prompt-launch", () => ({ launchAgentInWorkspace }));
vi.mock("../../../../lib/keybinding-commands", () => ({ resolveWorkspaceCommand: () => "claude" }));
vi.mock("../../ChatPane/usePaneChatView", () => ({ markChatStarting }));

import type { ProjectInfo } from "../../../../store/project-store";
import { useProjectStore } from "../../../../store/project-store";
import { useAppStore } from "../../../../store/app-store";
import type { NewAgentTarget } from "../new-agent-target";
import { useNewAgentSend } from "../useNewAgentSend";

const solo = {
  id: "solo",
  name: "solo",
  path: "/code/solo",
  hostId: "local",
  defaultBranch: "main",
  color: null,
  folders: [],
  sidebarOrder: [],
  group: null,
  workspaces: [
    { path: "/code/solo", branch: "main", isMain: true, name: null },
    { path: "/wt/feat", branch: "feat", isMain: false, name: "fix-login" },
  ],
} as unknown as ProjectInfo;

let container: HTMLDivElement;
let root: Root;
const createWorktree = vi.fn();

function Probe(props: { prompt: string; target: NewAgentTarget }) {
  const { prompt, target } = props;

  const send = useNewAgentSend();
  return createElement("button", { onClick: () => send(prompt, target) });
}

/** Send `prompt` to `target` the way the composer does: from a click. */
async function send(prompt: string, target: NewAgentTarget): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { prompt, target }));
  });
  await act(async () => {
    container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
  useProjectStore.setState({ projects: [solo], createWorktree });
  useAppStore.setState({
    activeSurface: "composer",
    composerDraft: { text: "fix the login bug", target: null },
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
});

describe("useNewAgentSend", () => {
  it("launches in an existing workspace and clears the draft", async () => {
    launchAgentInWorkspace.mockReturnValue({ tabId: "t", paneId: "p1" });
    await send("fix the login bug\n", { projectId: "solo", workspacePath: "/wt/feat", newWorktree: false });

    expect(launchAgentInWorkspace).toHaveBeenCalledWith("/wt/feat", {
      prompt: "fix the login bug",
      hostId: "local",
    });
    expect(markChatStarting).toHaveBeenCalledWith("p1");
    expect(useAppStore.getState().composerDraft.text).toBe("");
    expect(useAppStore.getState().activeSurface).toBe("workspace");
  });

  it("names a new worktree from the prompt, off the chosen workspace's branch", async () => {
    createWorktree.mockImplementation(async (_id, _name, opts) => {
      opts.onAgentPane("p2");
      return "/wt/fix-login-bug";
    });
    await send("fix login", { projectId: "solo", workspacePath: "/wt/feat", newWorktree: true });

    // "fix-login" is taken by an existing workspace.
    expect(createWorktree).toHaveBeenCalledWith("solo", "fix-login-2", expect.objectContaining({
      branch: "fix-login-2",
      baseBranch: "feat",
      agentPrompt: "fix login",
    }));
    expect(markChatStarting).toHaveBeenCalledWith("p2");
    expect(useAppStore.getState().activeSurface).toBe("workspace");
    expect(useAppStore.getState().composerDraft.text).toBe("");
  });

  it("branches main's worktree off the default branch, and keeps the draft on failure", async () => {
    createWorktree.mockResolvedValue(null);
    await send("fix the login bug", { projectId: "solo", workspacePath: "/code/solo", newWorktree: true });

    expect(createWorktree.mock.calls[0][2].baseBranch).toBe("main");
    expect(useAppStore.getState().composerDraft.text).toBe("fix the login bug");
  });
});
