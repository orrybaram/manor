import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, SessionSummary } from "../../../../electron.d";
import type { ModalRow } from "../agents-modal-list";

const goToAgentPane = vi.fn();
const resumeAgent = vi.fn();
vi.mock("../../../../lib/agent-resume", () => ({
  goToAgentPane: (a: AgentInfo) => goToAgentPane(a),
  resumeAgent: (a: AgentInfo) => resumeAgent(a),
}));

import { useAppStore } from "../../../../store/app-store";
import { useProjectStore } from "../../../../store/project-store";
import { useToastStore } from "../../../../store/toast-store";
import { inFolder, placeLaunch, planRowAction, runRowAction, sessionLaunchOf } from "../session-actions";

const project = { key: "p", name: "p", color: null };
const row = (over: Partial<ModalRow>): ModalRow => ({ id: "r", project, activityAt: "", ...over });

const agent = {
  id: "a1",
  hostId: "local",
  agentKind: "claude",
  agentSessionId: "s-agent",
  transcriptPath: null,
  cwd: "/repo/wt",
  workspacePath: "/repo/wt",
  paneId: "pane-1",
} as AgentInfo;

const session = {
  id: "codex:t1",
  hostId: "box",
  kind: "codex",
  sessionId: "t1",
  path: "/home/me/.codex/sessions/t1.jsonl",
  cwd: "/srv/app/api",
  updatedAt: "2026-10-01T00:00:00Z",
} as SessionSummary;

describe("planRowAction", () => {
  it("goes to the pane of an Agent whose pane is open", () => {
    expect(planRowAction(row({ agent }), "resume", true)).toEqual({ type: "go-to-pane", agent });
  });

  it("resumes an Agent whose pane is closed its own way", () => {
    expect(planRowAction(row({ agent, session }), "resume", false)).toEqual({ type: "resume-agent", agent });
  });

  it("launches a Session from outside Manor, on its host", () => {
    expect(planRowAction(row({ session }), "resume", false)).toEqual({
      type: "launch",
      action: "resume",
      launch: { hostId: "box", kind: "codex", sessionId: "t1", path: session.path, cwd: "/srv/app/api" },
    });
  });

  it("forks any row with a session, live or not", () => {
    const plan = planRowAction(row({ agent }), "fork", true);
    expect(plan).toMatchObject({ type: "launch", action: "fork", launch: { sessionId: "s-agent", kind: "claude" } });
  });

  it("does nothing for a row with no session id", () => {
    expect(sessionLaunchOf(row({ agent: { ...agent, agentSessionId: "" } }))).toBeNull();
    expect(planRowAction(row({ agent: { ...agent, agentSessionId: "" } }), "fork", false)).toEqual({ type: "none" });
  });
});

describe("placeLaunch", () => {
  const projects = [
    { hostId: "local", workspaces: [{ path: "/srv/app" }] },
    { hostId: "box", workspaces: [{ path: "/srv" }, { path: "/srv/app/" }] },
    { hostId: "box", workspaces: [{ path: "/srv/app/api/deeper" }] },
  ];

  it("picks the longest workspace on the session's host that contains its cwd", () => {
    expect(placeLaunch(projects, null, { hostId: "box", cwd: "/srv/app/api" })).toEqual({
      hostId: "box",
      workspacePath: "/srv/app/",
      cdTo: "/srv/app/api",
    });
  });

  it("runs in place when the workspace is the cwd", () => {
    expect(placeLaunch(projects, null, { hostId: "box", cwd: "/srv/app" })?.cdTo).toBeNull();
  });

  it("falls back to the active workspace on that host, else the host's first", () => {
    const active = { hostId: "box", path: "/srv/app/api/deeper" };
    expect(placeLaunch(projects, active, { hostId: "box", cwd: "/tmp/x" })).toEqual({
      hostId: "box",
      workspacePath: "/srv/app/api/deeper",
      cdTo: "/tmp/x",
    });
    expect(placeLaunch(projects, { hostId: "local", path: "/srv/app" }, { hostId: "box", cwd: "/tmp/x" })).toEqual({
      hostId: "box",
      workspacePath: "/srv",
      cdTo: "/tmp/x",
    });
  });

  it("has nowhere to go on a host with no workspace", () => {
    expect(placeLaunch(projects, null, { hostId: "elsewhere", cwd: "/srv/app" })).toBeNull();
  });
});

describe("inFolder", () => {
  it("changes to a quoted folder first", () => {
    expect(inFolder("claude --resume s", "/home/me/my repo")).toBe("cd '/home/me/my repo' && claude --resume s");
    expect(inFolder("claude --resume s", null)).toBe("claude --resume s");
  });
});

describe("runRowAction", () => {
  const buildSessionCommand = vi.fn();
  const setActiveWorkspace = vi.fn();
  const addTerminalTab = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
      ...((window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI ?? {}),
      agents: { buildSessionCommand },
    };
    useAppStore.setState({ setActiveWorkspace, addTerminalTab, activeWorkspacePath: null });
    useProjectStore.setState({
      projects: [{ hostId: "local", workspaces: [{ path: "/repo" }] }] as never,
    });
  });

  it("routes live and closed Agents to their own paths", () => {
    runRowAction(row({ agent }), "resume", true);
    expect(goToAgentPane).toHaveBeenCalledWith(agent);
    runRowAction(row({ agent }), "resume", false);
    expect(resumeAgent).toHaveBeenCalledWith(agent);
  });

  it("resumes an outside Session in a new tab of its workspace", async () => {
    buildSessionCommand.mockResolvedValue("claude --resume s1");
    runRowAction(row({ session: { ...session, hostId: "local", kind: "claude", sessionId: "s1", cwd: "/repo/pkg" } }), "resume", false);
    await vi.waitFor(() => expect(addTerminalTab).toHaveBeenCalled());
    expect(buildSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "local", kind: "claude", sessionId: "s1", workspacePath: "/repo" }),
      "resume",
    );
    expect(setActiveWorkspace).toHaveBeenCalledWith("/repo", "local");
    expect(addTerminalTab).toHaveBeenCalledWith("cd /repo/pkg && claude --resume s1", { kind: "agent-startup" });
  });

  it("says so when the session's host isn't connected", () => {
    const addToast = vi.spyOn(useToastStore.getState(), "addToast");
    runRowAction(row({ session }), "resume", false);
    return vi.waitFor(() => expect(addToast).toHaveBeenCalled()).then(() => {
      expect(buildSessionCommand).not.toHaveBeenCalled();
      expect(addTerminalTab).not.toHaveBeenCalled();
    });
  });
});
