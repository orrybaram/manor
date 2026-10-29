import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, SessionPreview, SessionRef, SessionSummary } from "../../../../electron.d";
import type { ModalRow } from "../agents-modal-list";
import {
  createLru,
  createPreviewLoader,
  previewIdentity,
  previewRef,
  type PreviewState,
} from "../session-preview";

const project = { key: "p", name: "p", color: null };

function row(over: Partial<ModalRow>): ModalRow {
  return { id: "r", project, activityAt: "2026-10-01T00:00:00Z", ...over };
}

const session = {
  hostId: "box",
  kind: "codex",
  sessionId: "s1",
  path: "/home/me/.codex/sessions/s1.jsonl",
  updatedAt: "2026-10-02T00:00:00Z",
} as SessionSummary;

const agent = {
  id: "a",
  hostId: "local",
  agentKind: "claude",
  agentSessionId: "s2",
  transcriptPath: "/home/me/.claude/projects/x/s2.jsonl",
  updatedAt: "2026-10-03T00:00:00Z",
} as AgentInfo;

describe("previewRef", () => {
  it("reads the Session's transcript when the row has one", () => {
    expect(previewRef(row({ session, agent }))).toEqual({
      hostId: "box",
      kind: "codex",
      sessionId: "s1",
      path: "/home/me/.codex/sessions/s1.jsonl",
    });
  });

  it("falls back to the Agent's own transcript", () => {
    expect(previewRef(row({ agent }))).toEqual({
      hostId: "local",
      kind: "claude",
      sessionId: "s2",
      path: "/home/me/.claude/projects/x/s2.jsonl",
    });
  });

  it("has nothing to read for an Agent with no transcript yet", () => {
    expect(previewRef(row({ agent: { ...agent, transcriptPath: null } }))).toBeNull();
  });
});

describe("previewIdentity", () => {
  it("is the same for an Agent before and after its Session joins, and ignores status changes", () => {
    const own = { ...agent, agentKind: "codex", agentSessionId: "s1" } as AgentInfo;
    expect(previewIdentity(row({ agent: own }))).toBe(previewIdentity(row({ agent: own, session })));
    expect(previewIdentity(row({ agent: { ...own, updatedAt: "2026-10-09T00:00:00Z" } }))).toBe(
      previewIdentity(row({ agent: own })),
    );
  });
});

describe("createLru", () => {
  it("drops the least recently used entry past its size", () => {
    const lru = createLru<number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe(1);
    expect(lru.get("c")).toBe(3);
  });
});

describe("createPreviewLoader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const ref: SessionRef = { hostId: "local", kind: "claude", sessionId: "s", path: "/p" };
  const preview = (text: string): SessionPreview => ({
    turns: [{ role: "user", text }],
    truncated: false,
  });

  function setup(fetch: (r: SessionRef) => Promise<SessionPreview>) {
    const states: Array<[string, PreviewState["status"]]> = [];
    const loader = createPreviewLoader(fetch, (key, state) => states.push([key, state.status]), {
      debounceMs: 100,
    });
    return { loader, states };
  }

  it("asks only once the highlight rests, and hands on only the newest answer", async () => {
    const fetch = vi.fn((r: SessionRef) => Promise.resolve(preview(r.sessionId)));
    const { loader, states } = setup(fetch);
    loader.show("a", { ...ref, sessionId: "a" });
    vi.advanceTimersByTime(50);
    loader.show("b", { ...ref, sessionId: "b" });
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].sessionId).toBe("b");
    expect(states).toEqual([
      ["a", "loading"],
      ["b", "loading"],
      ["b", "ready"],
    ]);
  });

  it("drops a slow answer for a row the highlight has left", async () => {
    let resolveA: (p: SessionPreview) => void = () => {};
    const fetch = vi.fn((r: SessionRef) =>
      r.sessionId === "a"
        ? new Promise<SessionPreview>((res) => (resolveA = res))
        : Promise.resolve(preview("b")),
    );
    const { loader, states } = setup(fetch);
    loader.show("a", { ...ref, sessionId: "a" });
    await vi.advanceTimersByTimeAsync(100);
    loader.show("b", { ...ref, sessionId: "b" });
    await vi.advanceTimersByTimeAsync(100);
    resolveA(preview("a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(states[states.length - 1]).toEqual(["b", "ready"]);
    expect(states.filter(([k, s]) => k === "a" && s === "ready")).toEqual([]);
  });

  it("shows a cached preview at once, and asks again after a failure", async () => {
    const fetch = vi
      .fn<(r: SessionRef) => Promise<SessionPreview>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(preview("x"));
    const { loader, states } = setup(fetch);
    loader.show("a", ref);
    await vi.advanceTimersByTimeAsync(100);
    expect(states[states.length - 1]).toEqual(["a", "error"]);
    loader.show("a", ref);
    await vi.advanceTimersByTimeAsync(100);
    expect(states[states.length - 1]).toEqual(["a", "ready"]);
    loader.show("b", { ...ref, sessionId: "b" });
    loader.show("a", ref);
    expect(states[states.length - 1]).toEqual(["a", "ready"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("has no transcript to show without a ref", () => {
    const fetch = vi.fn();
    const { loader, states } = setup(fetch);
    loader.show("a", null);
    expect(states).toEqual([["a", "none"]]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
