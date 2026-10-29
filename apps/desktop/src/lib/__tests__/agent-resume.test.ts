import { beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAgent } from "../agent-resume";
import { makeAgent } from "../../test-utils/fixtures";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useLaunchedSessions } from "../../store/launched-sessions-store";

const buildResumeCommand = vi.fn();
const addTerminalTab = vi.fn();
const setActiveWorkspace = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
    agents: { buildResumeCommand },
  };
  addTerminalTab.mockReturnValue({ tabId: "t", paneId: "pane-new" });
  useAppStore.setState({ addTerminalTab, setActiveWorkspace, workspaceLayouts: {} });
  useProjectStore.setState({ projects: [] });
  useLaunchedSessions.setState({ panes: {} });
});

describe("resumeAgent, for an Agent with no open pane", () => {
  it.each([
    ["codex", "codex resume th-1"],
    ["pi", "pi --session th-1"],
  ] as const)("types main's %s resume command, naming the kind", async (kind, command) => {
    buildResumeCommand.mockResolvedValue(command);
    const agent = makeAgent({
      id: "a1",
      agentKind: kind,
      agentSessionId: "th-1",
      status: "completed",
      paneId: null,
      workspacePath: "/repo",
      hostId: "local",
    });
    resumeAgent(agent);
    await vi.waitFor(() => expect(addTerminalTab).toHaveBeenCalled());
    expect(buildResumeCommand).toHaveBeenCalledWith("a1");
    expect(setActiveWorkspace).toHaveBeenCalledWith("/repo", "local");
    expect(addTerminalTab).toHaveBeenCalledWith(command, { kind: "agent-startup", agentKind: kind });
    expect(useLaunchedSessions.getState().panes).toEqual({ [`${kind}:th-1`]: "pane-new" });
  });

  it("opens nothing when main can't build a command", async () => {
    buildResumeCommand.mockResolvedValue(null);
    resumeAgent(makeAgent({ status: "completed", paneId: null, workspacePath: "/repo" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(addTerminalTab).not.toHaveBeenCalled();
  });
});
