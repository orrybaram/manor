// @vitest-environment happy-dom
/**
 * The chat's status line: branch, model and effort chips in each layout's
 * order, none left empty, a branch the agent's transcript disagrees with
 * flagged and explained, and background agents counted on a chip that opens
 * the task view (`TaskView.test.ts`).
 */
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionInfo } from "../../../../electron.d";
import type { LayoutMode } from "../../../../hooks/useLayoutMode";
import { useAppStore } from "../../../../store/app-store";
import { useProjectStore, type WorkspaceInfo } from "../../../../store/project-store";
import { makeProject } from "../../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
import type { TaskItem } from "../chat-entries";
import { ChatStatusLine } from "../ChatStatusLine";

const WS_PATH = "/repo/p1-ws";

function workspace(over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { path: WS_PATH, branch: "feat/chat-session-info", isMain: false, name: null, ...over };
}

const SESSION: ChatSessionInfo = {
  model: "claude-opus-5-5",
  effort: "medium",
  gitBranch: "feat/chat-session-info",
};

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function task(id: string, over: Partial<TaskItem> = {}): TaskItem {
  return {
    kind: "task",
    id,
    ts: "2026-01-01T00:00:00.000Z",
    taskKind: "agent",
    title: `Task ${id}`,
    agentType: "Explore",
    background: true,
    status: "running",
    display: "running",
    ...over,
  };
}

/** A background agent. */
const agent = (id: string, over: Partial<TaskItem> = {}) => task(id, over);
/** A background shell command. */
const shell = (id: string, over: Partial<TaskItem> = {}) =>
  task(id, { taskKind: "shell", agentType: undefined, ...over });

let root: TestRoot;

function render(props: {
  session?: ChatSessionInfo | null;
  layout?: LayoutMode;
  tasks?: readonly TaskItem[];
  onRevealTask?: (id: string) => void;
  lastMessageAt?: string | null;
  onToggleAgents?: () => void;
  taskViewOpen?: boolean;
  contextTokens?: number | null;
}): void {
  root.render(createElement(ChatStatusLine, props));
}

function testId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/** The chips in the order they're drawn, by what each says. */
function chipOrder(): string[] {
  const chips = testId("chat-status-chips");
  return [...(chips?.children ?? [])].map((c) => (c as HTMLElement).dataset.testid ?? c.textContent ?? "");
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [makeProject({ workspaces: [workspace()] })],
  });
  useAppStore.setState({ activeWorkspacePath: WS_PATH, activeWorkspaceHostId: "local" });
  root = createTestRoot();
  document.body.appendChild(root.container);
});

afterEach(() => {
  root.unmount();
  root.container.remove();
});

describe("ChatStatusLine — session chips", () => {
  it("shows the branch, model and effort, model by its display name", () => {
    render({ session: SESSION, layout: "desk" });
    expect(testId("chat-branch-chip")?.textContent).toBe("feat/chat-session-info");
    expect(testId("chat-model-chip")?.textContent).toBe("Opus 5.5");
    expect(testId("chat-effort-chip")?.textContent).toBe("medium");
    expect(testId("chat-branch-chip")?.dataset.mismatch).toBeUndefined();
  });

  it("orders the desk branch, model, effort, then the rest", () => {
    render({ session: SESSION, layout: "desk", tasks: [agent("a1"), shell("s1")] });
    expect(chipOrder()).toEqual([
      "chat-branch-chip",
      "chat-model-chip",
      "chat-effort-chip",
      "chat-agents-chip",
      "chat-running-chip",
    ]);
  });

  it("orders the phone branch, running, then model and effort last, the branch short", () => {
    render({
      session: SESSION,
      layout: "phone",
      tasks: [agent("a1"), shell("s1")],
      contextTokens: 12_000,
    });
    expect(chipOrder()).toEqual([
      "chat-branch-chip",
      "chat-agents-chip",
      "chat-running-chip",
      "chat-model-chip",
      "chat-effort-chip",
    ]);
    expect(testId("chat-branch-chip")?.textContent).toBe("chat-session-info");
    // The context size sits outside the scrolling chips.
    expect(testId("chat-status-chips")?.textContent).not.toContain("12k");
    expect(testId("chat-status-line")?.textContent).toContain("12k");
  });

  it("leaves the pull request, CI and diff to a phone", () => {
    useProjectStore.setState({
      projects: [
        makeProject({
          workspaces: [
            workspace({
              pr: {
                number: 7,
                state: "open",
                title: "Fix it",
                url: "https://github.com/o/r/pull/7",
                checks: { total: 1, passing: 1, failing: 0, pending: 0 },
              },
              diffStats: { added: 12, removed: 3 },
            }),
          ],
        }),
      ],
    });
    render({ session: SESSION, layout: "desk" });
    expect(chipOrder()).toEqual(["chat-branch-chip", "chat-model-chip", "chat-effort-chip"]);
    render({ session: SESSION, layout: "phone" });
    const phone = testId("chat-status-chips")?.textContent ?? "";
    expect(phone).toContain("#7");
    expect(phone).toContain("CI");
    expect(phone).toContain("+12");
  });

  it("draws nothing on the desk when the pull request is all there is", () => {
    useProjectStore.setState({
      projects: [
        makeProject({
          workspaces: [
            workspace({
              branch: "",
              pr: { number: 7, state: "open", title: "Fix it", url: "https://github.com/o/r/pull/7" },
            }),
          ],
        }),
      ],
    });
    render({ session: null, layout: "desk" });
    expect(testId("chat-status-line")).toBeNull();
  });

  it("leaves out a chip with nothing to show", () => {
    render({ session: { model: null, effort: null, gitBranch: null }, layout: "desk" });
    expect(testId("chat-branch-chip")).not.toBeNull();
    expect(testId("chat-model-chip")).toBeNull();
    expect(testId("chat-effort-chip")).toBeNull();
  });

  it("shows another agent kind's model as written", () => {
    render({ session: { model: "gpt-5.5-codex", effort: null, gitBranch: null }, layout: "desk" });
    expect(testId("chat-model-chip")?.textContent).toBe("gpt-5.5-codex");
    expect(testId("chat-effort-chip")).toBeNull();
  });
});

describe("ChatStatusLine — branch mismatch", () => {
  const ELSEWHERE: ChatSessionInfo = { ...SESSION, gitBranch: "main" };

  it("flags a transcript branch that differs from the workspace's", () => {
    render({ session: ELSEWHERE, layout: "desk" });
    const chip = testId("chat-branch-chip");
    expect(chip?.dataset.mismatch).toBe("true");
    expect(chip?.textContent).toBe("feat/chat-session-info ≠");
  });

  it("explains it in a sheet on a phone", async () => {
    render({ session: ELSEWHERE, layout: "phone" });
    await act(async () => testId("chat-branch-chip")?.click());
    const sheet = testId("chat-session-sheet");
    expect(sheet).not.toBeNull();
    expect(sheet?.textContent).toContain("feat/chat-session-info");
    expect(testId("chat-branch-mismatch")?.textContent).toBe(
      "The agent's transcript says it's on main.",
    );
  });

  it("explains it in a popover on the desk", async () => {
    render({ session: ELSEWHERE, layout: "desk" });
    const chip = testId("chat-branch-chip")!;
    await act(async () => {
      chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      chip.click();
    });
    expect(testId("chat-session-popover")).not.toBeNull();
    expect(testId("chat-branch-mismatch")?.textContent).toContain("main");
  });

  it("opens the same panel without a mismatch, and says nothing of one", async () => {
    render({ session: SESSION, layout: "phone" });
    await act(async () => testId("chat-branch-chip")?.click());
    expect(testId("chat-session-sheet")?.textContent).toContain("Opus 5.5");
    expect(testId("chat-branch-mismatch")).toBeNull();
  });
});

describe("ChatStatusLine — agents chip", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("isn't there with no background agent, or one that finished before your last message", () => {
    render({ layout: "desk", tasks: [] });
    expect(testId("chat-agents-chip")).toBeNull();
    render({
      layout: "desk",
      tasks: [agent("a1", { status: "ok", display: "ok" })],
      lastMessageAt: "2026-01-01T00:05:00.000Z",
    });
    expect(testId("chat-agents-chip")).toBeNull();
    expect(testId("chat-running-chip")).toBeNull();
  });

  it("names one agent, and many", () => {
    render({ layout: "desk", tasks: [agent("a1")] });
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent");
    render({ layout: "desk", tasks: [agent("a1"), agent("a2"), agent("a3", { status: "ok", display: "ok" })] });
    expect(testId("chat-agents-chip")?.textContent).toBe("2 agents · 1 done");
    expect(testId("chat-agents-chip")?.dataset.tone).toBe("pending");
  });

  it("leaves other running tasks on the running chip, and stale agents on neither", () => {
    render({
      layout: "desk",
      tasks: [
        agent("a1"),
        agent("stale", { display: "unknown" }),
        shell("s1"),
        task("fg", { background: false }),
      ],
    });
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent");
    expect(testId("chat-running-chip")?.textContent).toBe("2 running");
    render({ layout: "desk", tasks: [shell("s1")] });
    expect(testId("chat-agents-chip")).toBeNull();
    expect(testId("chat-running-chip")?.textContent).toBe("1 running");
  });

  const done = (id: string, over: Partial<TaskItem> = {}) =>
    agent(id, { status: "ok", display: "ok", durationMs: 60_000, ...over });

  it("says when they're all done, and stays until your next message lands", () => {
    const tasks = [done("a1"), done("a2"), done("a3")];
    render({ layout: "desk", tasks, lastMessageAt: "2026-01-01T00:00:30.000Z" });
    expect(testId("chat-agents-chip")?.textContent).toBe("3 agents done");
    expect(testId("chat-agents-chip")?.dataset.tone).toBeUndefined();
    render({ layout: "desk", tasks, lastMessageAt: "2026-01-01T00:05:00.000Z" });
    expect(testId("chat-agents-chip")).toBeNull();
  });

  it("counts only the agents that finished since your last message", () => {
    render({
      layout: "desk",
      tasks: [done("older", { durationMs: 1_000 }), done("newer", { durationMs: 120_000 }), agent("a3")],
      lastMessageAt: "2026-01-01T00:01:00.000Z",
    });
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent · 1 done");
  });

  it("flags a failure once none run", () => {
    render({ layout: "desk", tasks: [done("a1"), done("a2", { status: "error", display: "error" })] });
    expect(testId("chat-agents-chip")?.dataset.tone).toBe("failing");
  });

  it("asks for the task view, and stays while it's open", async () => {
    const onToggleAgents = vi.fn();
    render({ layout: "desk", tasks: [agent("a1")], onToggleAgents });
    await act(async () => testId("chat-agents-chip")?.click());
    expect(onToggleAgents).toHaveBeenCalledOnce();
    const tasks = [done("a1")];
    render({ layout: "desk", tasks, lastMessageAt: "2026-01-01T00:05:00.000Z", taskViewOpen: true });
    expect(testId("chat-agents-chip")?.getAttribute("aria-expanded")).toBe("true");
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent");
    render({ layout: "desk", tasks: [], taskViewOpen: true });
    expect(testId("chat-agents-chip")).toBeNull();
  });

  it("scrolls to and flashes the running chip's task in its chat on its own", async () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-chat-pane", "");
    const card = document.createElement("div");
    card.dataset.taskId = "s1";
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;
    pane.append(card, root.container);
    document.body.appendChild(pane);
    try {
      render({ layout: "phone", tasks: [shell("s1")] });
      await act(async () => testId("chat-running-chip")?.click());
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(card.className).toMatch(/taskFlash/);
    } finally {
      pane.remove();
    }
  });

  it("brings the newest other running task into view from the running chip", async () => {
    const onRevealTask = vi.fn();
    render({ layout: "desk", tasks: [shell("s1"), agent("a1"), shell("s2")], onRevealTask });
    await act(async () => testId("chat-running-chip")?.click());
    expect(onRevealTask).toHaveBeenCalledWith("s2");
  });
});
