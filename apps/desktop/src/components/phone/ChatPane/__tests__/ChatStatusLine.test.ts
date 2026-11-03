// @vitest-environment happy-dom
/**
 * The chat's status line: branch, model and effort chips in each layout's
 * order, none left empty, a branch the agent's transcript disagrees with
 * flagged and explained, and background agents named and listed.
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

  it("isn't there without a background agent running", () => {
    render({ layout: "desk", tasks: [agent("a1", { status: "ok", display: "ok" })] });
    expect(testId("chat-agents-chip")).toBeNull();
    expect(testId("chat-running-chip")).toBeNull();
  });

  it("names one agent, and many", () => {
    render({ layout: "desk", tasks: [agent("a1")] });
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent");
    render({ layout: "desk", tasks: [agent("a1"), agent("a2"), agent("a3", { status: "ok", display: "ok" })] });
    expect(testId("chat-agents-chip")?.textContent).toBe("2 agents");
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

  const LIST = [
    agent("done", {
      title: "Map the sheets",
      status: "ok",
      display: "ok",
      durationMs: 123_000,
    }),
    agent("old", { title: "Find the readers", ts: "2026-01-01T00:08:48.000Z" }),
    shell("s1"),
    agent("failed", { agentType: "general-purpose", status: "error", display: "error", durationMs: 5_000 }),
    agent("new", { title: "Draft the tests", agentType: "general-purpose", ts: "2026-01-01T00:09:16.000Z" }),
  ];

  function rows(): string[][] {
    return [...document.body.querySelectorAll<HTMLElement>('[data-testid="chat-agent-row"]')].map((row) => [
      row.dataset.agentId ?? "",
      row.textContent ?? "",
    ]);
  }

  it("lists the background agents in a sheet on a phone, running first", async () => {
    render({ layout: "phone", tasks: LIST });
    await act(async () => testId("chat-agents-chip")?.click());
    const sheet = testId("chat-agents-sheet");
    expect(sheet?.textContent).toContain("Background agents · 2 running");
    expect(rows()).toEqual([
      ["old", "Find the readersExplore · running 1m 12s"],
      ["new", "Draft the testsgeneral-purpose · running 44s"],
      ["done", "Map the sheetsExplore · done in 2m 3s"],
      ["failed", "Task failedgeneral-purpose · failed after 5s"],
    ]);
  });

  it("ticks the running times while the list is open", async () => {
    render({ layout: "phone", tasks: LIST });
    await act(async () => testId("chat-agents-chip")?.click());
    await act(async () => vi.advanceTimersByTime(3_000));
    expect(rows()[1][1]).toBe("Draft the testsgeneral-purpose · running 47s");
  });

  it("lists them in a popover on the desk", async () => {
    render({ layout: "desk", tasks: LIST });
    const chip = testId("chat-agents-chip")!;
    await act(async () => {
      chip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      chip.click();
    });
    expect(testId("chat-agents-popover")?.textContent).toContain("Background agents · 2 running");
    expect(rows().map(([id]) => id)).toEqual(["old", "new", "done", "failed"]);
  });

  it("closes the list and brings a picked agent's card into view", async () => {
    const onRevealTask = vi.fn();
    render({ layout: "phone", tasks: LIST, onRevealTask });
    await act(async () => testId("chat-agents-chip")?.click());
    const row = document.body.querySelector<HTMLElement>('[data-agent-id="done"]')!;
    await act(async () => row.click());
    expect(onRevealTask).toHaveBeenCalledWith("done");
    expect(testId("chat-agents-sheet")).toBeNull();
  });

  it("keeps the chip while its list is open and the last agent finishes", async () => {
    render({ layout: "phone", tasks: [agent("a1")] });
    await act(async () => testId("chat-agents-chip")?.click());
    render({ layout: "phone", tasks: [agent("a1", { status: "ok", display: "ok", durationMs: 9_000 })] });
    expect(testId("chat-agents-sheet")?.textContent).toContain("Background agents · none running");
    expect(rows()[0][1]).toBe("Task a1Explore · done in 9s");
  });

  it("scrolls to and flashes the picked agent's card in its chat on its own", async () => {
    const pane = document.createElement("div");
    pane.setAttribute("data-chat-pane", "");
    const card = document.createElement("div");
    card.dataset.taskId = "done";
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;
    pane.append(card, root.container);
    document.body.appendChild(pane);
    try {
      render({ layout: "phone", tasks: LIST });
      await act(async () => testId("chat-agents-chip")?.click());
      await act(async () => document.body.querySelector<HTMLElement>('[data-agent-id="done"]')?.click());
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
      expect(card.className).toMatch(/taskFlash/);
    } finally {
      pane.remove();
    }
  });

  it("doesn't reopen a list whose agents all went (a /clear) on the next agent's chip", async () => {
    render({ layout: "phone", tasks: [agent("a1")] });
    await act(async () => testId("chat-agents-chip")?.click());
    render({ layout: "phone", tasks: [] });
    render({ layout: "phone", tasks: [agent("a2")] });
    expect(testId("chat-agents-chip")?.textContent).toBe("1 agent");
    expect(testId("chat-agents-sheet")).toBeNull();
  });

  it("brings the newest other running task into view from the running chip", async () => {
    const onRevealTask = vi.fn();
    render({ layout: "desk", tasks: [shell("s1"), agent("a1"), shell("s2")], onRevealTask });
    await act(async () => testId("chat-running-chip")?.click());
    expect(onRevealTask).toHaveBeenCalledWith("s2");
  });
});
