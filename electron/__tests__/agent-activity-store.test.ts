import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import {
  AgentActivityStore,
  MAX_AGENTS,
  MAX_TRANSITIONS_PER_AGENT,
  RETENTION_MS,
  SAVE_DEBOUNCE_MS,
} from "../agent-activity-store";
import type { AgentInfo } from "../agent-persistence";
import type { AgentStatus } from "../terminal-host/types";

const T0 = new Date(2026, 8, 29, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;

function agent(id: string, overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    agentSessionId: `session-${id}`,
    name: `Agent ${id}`,
    status: "active",
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    completedAt: null,
    activatedAt: null,
    projectId: "project-1",
    projectName: "Project",
    hostId: "local",
    workspacePath: "/tmp/ws",
    cwd: "/tmp/ws",
    agentKind: "claude",
    agentCommand: null,
    paneId: `pane-${id}`,
    lastAgentStatus: null,
    resumedAt: null,
    ...overrides,
  };
}

function statuses(store: AgentActivityStore, id: string): AgentStatus[] {
  return store.getSnapshot().agents[id]?.transitions.map((t) => t.status) ?? [];
}

describe("AgentActivityStore", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    tmpDir = path.join(os.tmpdir(), `manor-activity-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    filePath = path.join(tmpDir, "agent-activity.json");
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts empty when the file is missing", () => {
    const store = new AgentActivityStore(tmpDir);
    const snapshot = store.getSnapshot();
    expect(snapshot.agents).toEqual({});
    expect(snapshot.sessions).toEqual([{ start: T0, end: T0 }]);
    expect(snapshot.now).toBe(T0);
  });

  it("starts empty on a corrupt file without throwing", () => {
    fs.writeFileSync(filePath, "{not json");
    const store = new AgentActivityStore(tmpDir);
    expect(store.getSnapshot().agents).toEqual({});
  });

  it("drops malformed entries from an otherwise valid file", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        agents: {
          good: {
            meta: { name: "ok", projectId: null, workspacePath: null, hostId: "local" },
            transitions: [
              { status: "working", at: T0 - 1000 },
              { status: "bogus", at: T0 - 500 },
            ],
          },
          noHost: { meta: {}, transitions: [{ status: "working", at: T0 }] },
          junk: 42,
        },
        sessions: [{ start: "x", end: 1 }, { start: T0 - 2000, end: T0 - 1000 }],
      }),
    );
    const snapshot = new AgentActivityStore(tmpDir).getSnapshot();
    expect(Object.keys(snapshot.agents)).toEqual(["good"]);
    expect(snapshot.agents.good.transitions).toEqual([
      { status: "working", at: T0 - 1000 },
    ]);
    expect(snapshot.sessions).toEqual([
      { start: T0 - 2000, end: T0 - 1000 },
      { start: T0, end: T0 },
    ]);
  });

  it("dedupes a status equal to the last one", () => {
    const store = new AgentActivityStore(tmpDir);
    const a = agent("a");
    store.record(a, "working", T0);
    store.record(a, "working", T0 + 1000);
    store.record(a, "thinking", T0 + 2000);
    store.record(a, "thinking", T0 + 3000);
    store.record(a, "working", T0 + 4000);
    expect(store.getSnapshot().agents.a.transitions).toEqual([
      { status: "working", at: T0 },
      { status: "thinking", at: T0 + 2000 },
      { status: "working", at: T0 + 4000 },
    ]);
  });

  it("refreshes meta on each record and notifies only on a change", () => {
    const store = new AgentActivityStore(tmpDir);
    const listener = vi.fn();
    store.onChange(listener);
    store.record(agent("a"), "working");
    store.record(agent("a"), "working");
    expect(listener).toHaveBeenCalledTimes(1);
    store.record(agent("a", { name: "Renamed" }), "working");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().agents.a.meta).toEqual({
      name: "Renamed",
      projectId: "project-1",
      workspacePath: "/tmp/ws",
      hostId: "local",
    });
  });

  it("keeps the last transition before the retention cutoff", () => {
    const store = new AgentActivityStore(tmpDir);
    const a = agent("a");
    store.record(a, "working", T0 - 30 * HOUR);
    store.record(a, "thinking", T0 - 26 * HOUR);
    store.record(a, "working", T0 - 2 * HOUR);
    expect(store.getSnapshot(T0).agents.a.transitions).toEqual([
      { status: "thinking", at: T0 - 26 * HOUR },
      { status: "working", at: T0 - 2 * HOUR },
    ]);
  });

  it("drops an Agent settled before the cutoff, keeps one still busy", () => {
    const store = new AgentActivityStore(tmpDir);
    store.record(agent("done"), "responded", T0 - 30 * HOUR);
    store.record(agent("busy"), "requires_input", T0 - 30 * HOUR);
    const agents = store.getSnapshot(T0).agents;
    expect(agents.done).toBeUndefined();
    expect(agents.busy.transitions).toEqual([
      { status: "requires_input", at: T0 - 30 * HOUR },
    ]);
  });

  it("caps transitions per Agent, dropping the oldest", () => {
    const store = new AgentActivityStore(tmpDir);
    const a = agent("a");
    const total = MAX_TRANSITIONS_PER_AGENT + 20;
    for (let i = 0; i < total; i++) {
      store.record(a, i % 2 === 0 ? "working" : "thinking", T0 - total + i);
    }
    const transitions = store.getSnapshot(T0).agents.a.transitions;
    expect(transitions).toHaveLength(MAX_TRANSITIONS_PER_AGENT);
    expect(transitions[transitions.length - 1].at).toBe(T0 - 1);
    expect(transitions[0].at).toBe(T0 - MAX_TRANSITIONS_PER_AGENT);
  });

  it("caps Agents, dropping the least recently active", () => {
    const store = new AgentActivityStore(tmpDir);
    const total = MAX_AGENTS + 5;
    for (let i = 0; i < total; i++) {
      store.record(agent(`a${i}`), "working", T0 - HOUR + i);
    }
    const ids = Object.keys(store.getSnapshot(T0).agents);
    expect(ids).toHaveLength(MAX_AGENTS);
    for (let i = 0; i < 5; i++) expect(ids).not.toContain(`a${i}`);
    expect(ids).toContain(`a${total - 1}`);
  });

  it("records the running session, ending at now in snapshots", () => {
    const store = new AgentActivityStore(tmpDir);
    expect(store.getSnapshot(T0 + HOUR).sessions).toEqual([
      { start: T0, end: T0 + HOUR },
    ]);
  });

  it("extends the session end on each save and on flush", () => {
    const store = new AgentActivityStore(tmpDir);
    store.record(agent("a"), "working");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    let file = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(file.sessions).toEqual([{ start: T0, end: T0 + SAVE_DEBOUNCE_MS }]);

    vi.setSystemTime(T0 + HOUR);
    store.flush();
    file = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(file.sessions).toEqual([{ start: T0, end: T0 + HOUR }]);
  });

  it("debounces writes", () => {
    const store = new AgentActivityStore(tmpDir);
    store.record(agent("a"), "working");
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(fs.existsSync(filePath)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("round-trips history and appends a new session per run", () => {
    const first = new AgentActivityStore(tmpDir);
    first.record(agent("a"), "working", T0);
    first.record(agent("a"), "responded", T0 + 1000);
    vi.setSystemTime(T0 + HOUR);
    first.flush();

    vi.setSystemTime(T0 + 2 * HOUR);
    const second = new AgentActivityStore(tmpDir);
    expect(statuses(second, "a")).toEqual(["working", "responded"]);
    expect(second.getSnapshot().agents.a.meta.name).toBe("Agent a");
    expect(second.getSnapshot().sessions).toEqual([
      { start: T0, end: T0 + HOUR },
      { start: T0 + 2 * HOUR, end: T0 + 2 * HOUR },
    ]);
  });

  it("drops sessions that ended before the retention window", () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        agents: {},
        sessions: [
          { start: T0 - RETENTION_MS - 2 * HOUR, end: T0 - RETENTION_MS - HOUR },
          { start: T0 - RETENTION_MS - HOUR, end: T0 - HOUR },
        ],
      }),
    );
    const store = new AgentActivityStore(tmpDir);
    expect(store.getSnapshot().sessions).toEqual([
      { start: T0 - RETENTION_MS - HOUR, end: T0 - HOUR },
      { start: T0, end: T0 },
    ]);
  });

  it("returns a detached snapshot", () => {
    const store = new AgentActivityStore(tmpDir);
    store.record(agent("a"), "working");
    const snapshot = store.getSnapshot();
    snapshot.agents.a.transitions.push({ status: "error", at: T0 });
    expect(statuses(store, "a")).toEqual(["working"]);
  });
});
