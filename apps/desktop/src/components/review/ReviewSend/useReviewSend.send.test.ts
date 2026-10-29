// @vitest-environment jsdom
/**
 * `useReviewSend`'s Send: the workspace's drafts go to the chosen target on
 * the workspace's host in one batch, then the drafts are gone; and only that
 * host's agents are offered.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../../electron.d";
import { useAgentStore } from "../../../store/agent-store";
import { useReviewStore } from "../../../store/review-store";
import { useReviewSend, type ReviewSend } from "./useReviewSend";

const submitReview = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/review-submit", () => ({ submitReview }));

const WS = "/repo/ws";

const agent = (over: Partial<AgentInfo>): AgentInfo =>
  ({
    id: "a",
    name: "Claude",
    status: "active",
    hostId: "local",
    workspacePath: WS,
    paneId: "pane-a",
    agentKind: "claude",
    updatedAt: "2026-10-29T10:00:00.000Z",
    ...over,
  }) as AgentInfo;

let container: HTMLDivElement;
let root: Root;
let latest: ReviewSend | null = null;

function Probe({ hostId }: { hostId?: string }) {
  latest = useReviewSend(WS, hostId);
  return null;
}

function mount(hostId?: string): void {
  act(() => root.render(createElement(Probe, { hostId })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  submitReview.mockClear();
  useReviewStore.setState({ drafts: {} });
  useAgentStore.setState({ agents: [] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useReviewSend", () => {
  it("sends the workspace's drafts to the chosen agent on its host, then clears them", () => {
    const store = useReviewStore.getState();
    store.addDraft(WS, {
      filePath: "src/a.ts",
      startLine: 3,
      endLine: 4,
      snippet: "const a = 1;",
      startLabel: "L3–L4",
      body: "Why?",
    });
    store.addDraft(WS, {
      filePath: "src/b.ts",
      startLine: 9,
      endLine: 9,
      snippet: "b()",
      startLabel: "L9",
      body: "Rename this",
    });
    store.addDraft("/repo/other", {
      filePath: "x.ts",
      snippet: "",
      startLabel: "L1",
      body: "not this workspace's",
    });
    const target = agent({ id: "remote-agent", hostId: "box" });
    useAgentStore.setState({ agents: [target] });
    mount("box");

    expect(latest!.comments.map((c) => c.body)).toEqual(["Why?", "Rename this"]);
    expect(latest!.defaultTarget).toEqual({ kind: "agent", agent: target });
    const drafts = latest!.comments;
    act(() => latest!.send({ kind: "agent", agent: target }));

    expect(submitReview).toHaveBeenCalledTimes(1);
    expect(submitReview).toHaveBeenCalledWith(WS, drafts, { kind: "agent", agent: target }, "box");
    expect(useReviewStore.getState().drafts[WS]).toBeUndefined();
    expect(latest!.comments).toEqual([]);
    // Another workspace's review is left alone.
    expect(useReviewStore.getState().drafts["/repo/other"]).toHaveLength(1);
  });

  it("sends to a new agent when that is the target", () => {
    useReviewStore.getState().addDraft(WS, {
      filePath: "src/a.ts",
      snippet: "",
      startLabel: "L1",
      body: "Look",
    });
    mount();
    expect(latest!.defaultTarget).toEqual({ kind: "new" });
    act(() => latest!.send({ kind: "new" }));
    expect(submitReview).toHaveBeenCalledWith(WS, expect.any(Array), { kind: "new" }, undefined);
    expect(useReviewStore.getState().drafts[WS]).toBeUndefined();
  });

  it("offers only live agents on the workspace's host, newest first", () => {
    const older = agent({ id: "older", updatedAt: "2026-10-29T09:00:00.000Z" });
    const newer = agent({ id: "newer", updatedAt: "2026-10-29T11:00:00.000Z" });
    useAgentStore.setState({
      agents: [
        older,
        newer,
        // The same path on another host is another workspace.
        agent({ id: "elsewhere", hostId: "box" }),
        agent({ id: "done", status: "completed" }),
        agent({ id: "paneless", paneId: null }),
        agent({ id: "other-ws", workspacePath: "/repo/other" }),
      ],
    });

    mount();
    expect(latest!.agents.map((a) => a.id)).toEqual(["newer", "older"]);

    mount("box");
    expect(latest!.agents.map((a) => a.id)).toEqual(["elsewhere"]);
  });
});
