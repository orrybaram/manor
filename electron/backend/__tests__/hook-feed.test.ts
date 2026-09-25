import { describe, it, expect, vi, afterEach } from "vitest";

import {
  HostHookFeed,
  NotificationCoalescer,
  memoryHookSeqStore,
  type HookSink,
} from "../hook-feed";
import { AgentHookServer } from "../../agent-hooks";
import { createHookRelay } from "../../hook-relay";
import type { AgentInfo } from "../../agent-persistence";
import type { HookJournalEntry, HookPayload } from "../../terminal-host/types";

const HOST = "box";

function payload(seq: number): HookPayload {
  return { paneId: "pane-1", eventType: "PreToolUse", kind: "claude", tag: String(seq) };
}

function entry(seq: number): HookJournalEntry {
  return { seq, receivedAt: seq, payload: payload(seq) };
}

function entries(from: number, to: number): HookJournalEntry[] {
  const out: HookJournalEntry[] = [];
  for (let seq = from; seq <= to; seq++) out.push(entry(seq));
  return out;
}

type ReplayResult = { entries: HookJournalEntry[]; lastSeq: number } | null;

/** A replay source whose answers the test releases by hand. */
function deferredReplay() {
  const calls: Array<{ sinceSeq: number; resolve: (r: ReplayResult) => void; reject: (e: Error) => void }> = [];
  const replay = vi.fn(
    (sinceSeq: number) =>
      new Promise<ReplayResult>((resolve, reject) => {
        calls.push({ sinceSeq, resolve, reject });
      }),
  );
  return { replay, calls };
}

function recordingSink() {
  const ingested: Array<{ tag: string; replay: boolean }> = [];
  const finished: string[] = [];
  const sink: HookSink = {
    ingest: (p, ctx) => ingested.push({ tag: p.tag, replay: ctx.replay }),
    replayFinished: (hostId) => finished.push(hostId),
  };
  return { sink, ingested, finished, tags: () => ingested.map((i) => Number(i.tag)) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeFeed(opts: { lastSeq?: number; replay: (s: number) => Promise<ReplayResult>; sink?: HookSink | null; retryDelayMs?: (a: number) => number }) {
  const store = memoryHookSeqStore();
  if (opts.lastSeq) store.set(HOST, opts.lastSeq);
  const feed = new HostHookFeed({
    hostId: HOST,
    replay: opts.replay,
    store,
    sink: () => opts.sink ?? null,
    retryDelayMs: opts.retryDelayMs,
  });
  return { feed, store };
}

describe("HostHookFeed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("replays from lastHookSeq, then drains held live events in order, skipping duplicates", async () => {
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed, store } = makeFeed({ lastSeq: 2, replay, sink: rec.sink });

    // Live events that arrived before the connect finished are held too.
    feed.onLiveEvent(4, payload(4));
    feed.catchUp();
    expect(calls[0].sinceSeq).toBe(2);
    // Interleaved with the replay: some the journal will also return, some newer.
    feed.onLiveEvent(5, payload(5));
    feed.onLiveEvent(6, payload(6));
    feed.onLiveEvent(7, payload(7));
    expect(rec.ingested).toEqual([]);

    calls[0].resolve({ entries: entries(3, 5), lastSeq: 5 });
    await flush();

    expect(rec.tags()).toEqual([3, 4, 5, 6, 7]);
    expect(rec.ingested.every((i) => i.replay)).toBe(true);
    expect(rec.finished).toEqual([HOST]);
    expect(store.get(HOST)).toBe(7);

    // Live now: a duplicate is skipped, the next one goes straight through.
    feed.onLiveEvent(7, payload(7));
    feed.onLiveEvent(8, payload(8));
    expect(rec.tags()).toEqual([3, 4, 5, 6, 7, 8]);
    expect(rec.ingested[rec.ingested.length - 1]).toEqual({ tag: "8", replay: false });
    expect(store.get(HOST)).toBe(8);
  });

  it("replays what remains when the journal was compacted past lastHookSeq", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed, store } = makeFeed({ lastSeq: 2, replay, sink: rec.sink });

    feed.catchUp();
    calls[0].resolve({ entries: entries(10, 12), lastSeq: 12 });
    await flush();

    expect(rec.tags()).toEqual([10, 11, 12]);
    expect(store.get(HOST)).toBe(12);
    expect(warn.mock.calls.some(([m]) => String(m).includes("3–9"))).toBe(true);

    feed.onLiveEvent(13, payload(13));
    expect(rec.tags()).toEqual([10, 11, 12, 13]);
  });

  it("jumps to the journal's lastSeq when everything after lastHookSeq aged out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed, store } = makeFeed({ lastSeq: 2, replay, sink: rec.sink });

    feed.catchUp();
    calls[0].resolve({ entries: [], lastSeq: 9 });
    await flush();
    expect(rec.tags()).toEqual([]);
    expect(store.get(HOST)).toBe(9);
    feed.onLiveEvent(10, payload(10));
    expect(rec.tags()).toEqual([10]);
  });

  it("starts over from 0 when the journal is behind lastHookSeq (it was reset)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed, store } = makeFeed({ lastSeq: 50, replay, sink: rec.sink });

    feed.catchUp();
    calls[0].resolve({ entries: [], lastSeq: 3 });
    await flush();
    expect(calls[1].sinceSeq).toBe(0);
    calls[1].resolve({ entries: entries(1, 3), lastSeq: 3 });
    await flush();
    expect(rec.tags()).toEqual([1, 2, 3]);
    expect(store.get(HOST)).toBe(3);
  });

  it("goes back to the journal when a live event skips a seq", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed } = makeFeed({ replay, sink: rec.sink });

    feed.catchUp();
    calls[0].resolve({ entries: entries(1, 2), lastSeq: 2 });
    await flush();

    // Seq 3 never arrived live.
    feed.onLiveEvent(4, payload(4));
    expect(rec.tags()).toEqual([1, 2]);
    expect(calls[1].sinceSeq).toBe(2);
    feed.onLiveEvent(5, payload(5));
    calls[1].resolve({ entries: entries(3, 4), lastSeq: 4 });
    await flush();
    expect(rec.tags()).toEqual([1, 2, 3, 4, 5]);
  });

  it("retries a failed replay, holding live events meanwhile", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed } = makeFeed({ replay, sink: rec.sink, retryDelayMs: () => 0 });

    feed.catchUp();
    feed.onLiveEvent(1, payload(1));
    calls[0].reject(new Error("socket closed"));
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
    feed.onLiveEvent(2, payload(2));
    expect(rec.tags()).toEqual([]);
    calls[1].resolve({ entries: entries(1, 1), lastSeq: 1 });
    await flush();
    expect(rec.tags()).toEqual([1, 2]);
  });

  it("discards a replay that lands after the host went away", async () => {
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    const { feed, store } = makeFeed({ replay, sink: rec.sink });

    feed.catchUp();
    feed.pause();
    calls[0].resolve({ entries: entries(1, 3), lastSeq: 3 });
    await flush();
    expect(rec.tags()).toEqual([]);
    expect(store.get(HOST)).toBe(0);
  });

  it("waits for a sink before catching up", async () => {
    const { replay, calls } = deferredReplay();
    const rec = recordingSink();
    let sink: HookSink | null = null;
    const store = memoryHookSeqStore();
    const feed = new HostHookFeed({ hostId: HOST, replay, store, sink: () => sink });

    feed.catchUp();
    expect(calls).toHaveLength(0);
    sink = rec.sink;
    feed.catchUp();
    calls[0].resolve({ entries: entries(1, 1), lastSeq: 1 });
    await flush();
    expect(rec.tags()).toEqual([1]);
  });

  it("keeps going past a hook the sink throws on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { replay, calls } = deferredReplay();
    const seen: string[] = [];
    const sink: HookSink = {
      ingest: (p) => {
        seen.push(p.tag);
        if (p.tag === "1") throw new Error("boom");
      },
    };
    const { feed, store } = makeFeed({ replay, sink });
    feed.catchUp();
    calls[0].resolve({ entries: entries(1, 2), lastSeq: 2 });
    await flush();
    expect(seen).toEqual(["1", "2"]);
    expect(store.get(HOST)).toBe(2);
  });
});

describe("NotificationCoalescer", () => {
  const agent = (id: string, lastAgentStatus: string) =>
    ({ id, lastAgentStatus }) as unknown as AgentInfo;

  it("passes calls through outside a hold", () => {
    const notify = vi.fn();
    const coalescer = new NotificationCoalescer(notify);
    coalescer.send(agent("a", "responded"), "thinking", "responded");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("holds replayed notifications and sends one per agent, its last transition", () => {
    const notify = vi.fn();
    const coalescer = new NotificationCoalescer(notify);
    coalescer.hold(HOST, () => {
      coalescer.send(agent("a", "requires_input"), "working", "requires_input");
      coalescer.send(agent("b", "responded"), "thinking", "responded");
      coalescer.send(agent("a", "responded"), "working", "responded");
    });
    // A local notification during the replay is not held.
    coalescer.send(agent("local", "responded"), "thinking", "responded");
    expect(notify.mock.calls.map(([a]) => a.id)).toEqual(["local"]);

    coalescer.flush(HOST);
    expect(notify.mock.calls.slice(1).map(([a, prev, next]) => [a.id, prev, next])).toEqual([
      ["b", "thinking", "responded"],
      ["a", "working", "responded"],
    ]);
    coalescer.flush(HOST);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it("flushes per host", () => {
    const notify = vi.fn();
    const coalescer = new NotificationCoalescer(notify);
    coalescer.hold("h1", () => coalescer.send(agent("a", "responded"), "thinking", "responded"));
    coalescer.hold("h2", () => coalescer.send(agent("b", "responded"), "thinking", "responded"));
    coalescer.flush("h1");
    expect(notify.mock.calls.map(([a]) => a.id)).toEqual(["a"]);
  });
});

describe("replay through the real ingest path", () => {
  function fakeAgentManager() {
    const agents = new Map<string, AgentInfo>();
    let counter = 0;
    return {
      createAgent(data: Omit<AgentInfo, "id" | "createdAt" | "updatedAt" | "activatedAt">): AgentInfo {
        const agent = { ...data, id: `agent-${++counter}`, activatedAt: null } as AgentInfo;
        agents.set(agent.agentSessionId!, agent);
        return agent;
      },
      updateAgent(id: string, updates: Partial<AgentInfo>): AgentInfo | null {
        for (const [key, a] of agents) {
          if (a.id !== id) continue;
          const updated = { ...a, ...updates, id } as AgentInfo;
          agents.set(key, updated);
          return updated;
        }
        return null;
      },
      getAgentBySessionId: (s: string) => agents.get(s) ?? null,
      getAgentByPaneId: (p: string) => [...agents.values()].find((a) => a.paneId === p) ?? null,
      getActiveAgents: () => [...agents.values()].filter((a) => a.status === "active"),
    };
  }

  it("a night of replayed turns yields one notification per agent", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    const notify = vi.fn();
    const coalescer = new NotificationCoalescer(notify);
    const server = new AgentHookServer();
    const { relay } = createHookRelay({
      relayAgentHook: vi.fn(),
      agentManager: fakeAgentManager(),
      getPaneContext: () => ({
        projectId: "p",
        projectName: "proj",
        workspacePath: "/w",
        agentCommand: "claude",
      }),
      unseenRespondedAgents: new Set(),
      unseenInputAgents: new Set(),
      broadcastAgent: vi.fn(),
      maybeSendNotification: coalescer.send,
    });
    server.setRelay(relay);

    const sink: HookSink = {
      ingest: (p, { hostId, replay }) => {
        const run = () => server.ingestHookPayload(p, { hostId });
        if (replay) coalescer.hold(hostId, run);
        else run();
      },
      replayFinished: (hostId) => coalescer.flush(hostId),
    };

    const turn = (sessionId: string, paneId: string) =>
      ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].map(
        (eventType) => ({ paneId, eventType, kind: "claude", sessionId }),
      );
    const journal = [
      ...turn("s1", "pane-1"),
      ...turn("s2", "pane-2"),
      { paneId: "pane-1", eventType: "UserPromptSubmit", kind: "claude", sessionId: "s1" },
      { paneId: "pane-1", eventType: "PermissionRequest", kind: "claude", sessionId: "s1" },
      { paneId: "pane-1", eventType: "PostToolUse", kind: "claude", sessionId: "s1" },
      { paneId: "pane-1", eventType: "Stop", kind: "claude", sessionId: "s1" },
    ].map((p, i) => ({ seq: i + 1, receivedAt: 0, payload: p }));

    const feed = new HostHookFeed({
      hostId: HOST,
      replay: async () => ({ entries: journal, lastSeq: journal.length }),
      store: memoryHookSeqStore(),
      sink: () => sink,
    });
    feed.catchUp();
    await flush();

    // s1 needed input and responded twice, s2 responded once: one banner each,
    // for the state they ended in.
    const sent = notify.mock.calls.map(([a, , next]) => [a.agentSessionId, next]);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        ["s1", "responded"],
        ["s2", "responded"],
      ]),
    );

    // After the catch-up, live hooks notify immediately.
    feed.onLiveEvent(journal.length + 1, { paneId: "pane-2", eventType: "UserPromptSubmit", kind: "claude", sessionId: "s2" });
    feed.onLiveEvent(journal.length + 2, { paneId: "pane-2", eventType: "PermissionRequest", kind: "claude", sessionId: "s2" });
    expect(notify.mock.calls[notify.mock.calls.length - 1]?.[2]).toBe("requires_input");
  });
});
