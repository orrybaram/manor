import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AgentInfo } from "../../electron.d";
import type { DraftComment } from "../../store/review-store";
import { useToastStore } from "../../store/toast-store";
import { reviewPrompt, submitReview } from "../review-submit";
import { startAgentWithPrompt } from "../agent-prompt-launch";
import { navigateToAgent } from "../../utils/agent-navigation";

// `flattenPrompt` is kept real — the "prompt arrives as one line" guarantee
// below is only worth asserting against the implementation that ships.
vi.mock("../agent-prompt-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent-prompt-launch")>()),
  startAgentWithPrompt: vi.fn(),
}));

vi.mock("../../utils/agent-navigation", () => ({
  navigateToAgent: vi.fn(),
}));

// window is provided by the setup file (src/store/__tests__/setup.ts)
const write = vi.fn();
(window as unknown as Record<string, unknown>).electronAPI = {
  ...(window.electronAPI as unknown as Record<string, unknown>),
  pty: { write },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_PATH = "/test/workspace";

function makeComment(overrides: Partial<DraftComment> = {}): DraftComment {
  return {
    id: "c1",
    filePath: "src/store/app-store.ts",
    startIndex: 10,
    endIndex: 14,
    snippet: "120: const x = 1",
    startLabel: "L120",
    body: "This should be a constant.",
    createdAt: 0,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: "agent-1",
    agentSessionId: "session-1",
    name: "refactor the store",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    activatedAt: null,
    projectId: "project-1",
    projectName: "manor",
    workspacePath: WS_PATH,
    cwd: WS_PATH,
    agentKind: "claude",
    agentCommand: null,
    paneId: "pane-1",
    lastAgentStatus: "working",
    resumedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
});

// ---------------------------------------------------------------------------
// reviewPrompt
// ---------------------------------------------------------------------------

describe("reviewPrompt", () => {
  it("uses singular wording and numbers a single comment", () => {
    const prompt = reviewPrompt([makeComment()]);

    expect(prompt.split("\n")[0]).toContain("I left a comment");
    expect(prompt).toContain(
      "[1] src/store/app-store.ts L120 — This should be a constant.",
    );
    expect(prompt).toContain("Code: 120: const x = 1");
  });

  it("numbers every comment and keeps its body and snippet", () => {
    const prompt = reviewPrompt([
      makeComment({ id: "a", body: "first note" }),
      makeComment({
        id: "b",
        filePath: "src/lib/harness.ts",
        startLabel: "L4-L8",
        body: "second note",
        snippet: "4: export interface HarnessAdapter {",
      }),
      makeComment({ id: "c", body: "third note" }),
    ]);

    expect(prompt.split("\n")[0]).toContain("I left 3 comments");
    expect(prompt).toContain("[1] src/store/app-store.ts L120 — first note");
    expect(prompt).toContain("[2] src/lib/harness.ts L4-L8 — second note");
    expect(prompt).toContain("[3] src/store/app-store.ts L120 — third note");
    expect(prompt).toContain("Code: 4: export interface HarnessAdapter {");
  });

  /**
   * A comment on a diff is as often a question as a request. An imperative
   * preamble ("address these comments") sends the agent off editing code that
   * the user only asked about, so the framing has to leave answering open.
   */
  it("does not instruct the agent to change code unconditionally", () => {
    const preamble = reviewPrompt([
      makeComment({ id: "a", body: "what does this do?" }),
      makeComment({ id: "b", body: "and this?" }),
    ]).split("\n")[0];

    expect(preamble).not.toMatch(/^Address/);
    expect(preamble).toContain("may be questions");
    expect(preamble).toContain("only edit code where a comment actually asks");
  });
});

// ---------------------------------------------------------------------------
// submitReview
// ---------------------------------------------------------------------------

describe("submitReview", () => {
  it("interrupts a running agent, then writes the prompt as one line", () => {
    const agent = makeAgent();
    submitReview(WS_PATH, [makeComment()], { kind: "agent", agent });

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]).toEqual(["pane-1", "\x1b"]);

    const [paneId, data] = write.mock.calls[1] as [string, string];
    expect(paneId).toBe("pane-1");
    expect(data.endsWith("\r")).toBe(true);
    // A bare newline submits the turn in a harness's prompt box, which would
    // deliver a batched review as several half-messages.
    expect(data).not.toContain("\n");
    expect(data).toContain("This should be a constant.");

    expect(navigateToAgent).toHaveBeenCalledWith(agent);
    expect(startAgentWithPrompt).not.toHaveBeenCalled();
  });

  it("uses the interrupt sequence of the agent's harness", () => {
    submitReview(WS_PATH, [makeComment()], {
      kind: "agent",
      agent: makeAgent({ agentKind: "codex" }),
    });

    expect(write.mock.calls[0]).toEqual(["pane-1", "\x03"]);
  });

  it("toasts what was sent and where", () => {
    submitReview(
      WS_PATH,
      [makeComment({ id: "a" }), makeComment({ id: "b" })],
      {
        kind: "agent",
        agent: makeAgent(),
      },
    );

    const toast = useToastStore.getState().toasts[0];
    expect(toast.message).toBe("Sent 2 comments to refactor the store");
    expect(toast.status).toBe("success");
  });

  it("refuses an agent with no live pane", () => {
    submitReview(WS_PATH, [makeComment()], {
      kind: "agent",
      agent: makeAgent({ paneId: null }),
    });

    expect(write).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts[0].status).toBe("error");
  });

  it("starts a new agent without touching any pty", () => {
    submitReview(WS_PATH, [makeComment()], { kind: "new" });

    expect(write).not.toHaveBeenCalled();
    expect(startAgentWithPrompt).toHaveBeenCalledTimes(1);
    const [workspacePath, prompt] =
      vi.mocked(startAgentWithPrompt).mock.calls[0];
    expect(workspacePath).toBe(WS_PATH);
    expect(prompt).toContain("I left a comment on the current diff.");
    expect(useToastStore.getState().toasts[0].message).toBe(
      "Sent 1 comment to a new agent",
    );
  });

  it("does nothing when there is nothing to send", () => {
    submitReview(WS_PATH, [], { kind: "new" });

    expect(write).not.toHaveBeenCalled();
    expect(startAgentWithPrompt).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
