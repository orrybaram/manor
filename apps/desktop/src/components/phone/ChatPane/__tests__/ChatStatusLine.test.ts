// @vitest-environment happy-dom
/**
 * The chat's status line: branch, model and effort chips in each layout's
 * order, none left empty, and a branch the agent's transcript disagrees with
 * flagged and explained.
 */
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatSessionInfo } from "../../../../electron.d";
import type { LayoutMode } from "../../../../hooks/useLayoutMode";
import { useAppStore } from "../../../../store/app-store";
import { useProjectStore, type WorkspaceInfo } from "../../../../store/project-store";
import { makeProject } from "../../../../test-utils/fixtures";
import { createTestRoot, type TestRoot } from "../../../../test-utils/react-root";
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

let root: TestRoot;

function render(props: {
  session?: ChatSessionInfo | null;
  layout?: LayoutMode;
  runningTasks?: number;
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
    render({ session: SESSION, layout: "desk", runningTasks: 2 });
    expect(chipOrder()).toEqual([
      "chat-branch-chip",
      "chat-model-chip",
      "chat-effort-chip",
      "chat-running-chip",
    ]);
  });

  it("orders the phone branch, running, then model and effort last, the branch short", () => {
    render({ session: SESSION, layout: "phone", runningTasks: 2, contextTokens: 12_000 });
    expect(chipOrder()).toEqual([
      "chat-branch-chip",
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
