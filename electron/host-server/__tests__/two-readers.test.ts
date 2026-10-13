/**
 * Two readers of one journal (ADR-225 D2, Consequences).
 *
 * In slice 1 the desktop and the host server both derive the agents on a
 * host from its daemon's hook journal, and agree only because both run the
 * same ingestion path into the same pure reconciler. A side effect slipped
 * into the reconciler, or a host-server shortcut around
 * `AgentHookServer.ingestHookPayload`, would split them. This feeds one
 * recorded journal — part replayed, part live, as each reader meets it —
 * into the desktop's pipeline (`createAgentPipeline` as `app-lifecycle.ts`
 * configures it for a remote host) and into the host server's
 * (`createHostAgents`), and requires every pane to end in the same state.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager, type AgentInfo } from "../../agent-persistence";
import { UnseenAgents } from "../../agent-status/unseen-agents";
import type { AgentStatusDriver } from "../../agent-status/driver";
import {
  createAgentPipeline,
  desktopAgentPipelineOptions,
} from "../../agent-status/pipeline";
import { HostHookFeed, memoryHookSeqStore } from "../../backend/hook-feed";
import { LOCAL_HOST_ID } from "../../backend/types";
import { HookJournal } from "../../terminal-host/hook-journal";
import type { HookPayload, HookReplay } from "../../terminal-host/types";
import { createHostAgents } from "../agents";
import { fileHookCursorStore } from "../hook-cursor";

const REMOTE_HOST = "wsl-box";

/** One clock for both readers, so time-based rules see the same "now". */
let now = 1_700_000_000_000;
const clock = () => now;

function hook(
  paneId: string,
  eventType: string,
  sessionId: string,
  extra: Record<string, string> = {},
): HookPayload {
  return { paneId, eventType, kind: "claude", sessionId, ...extra };
}

/**
 * A recorded day on a box: two agents in two panes, tool calls, a
 * permission prompt, a subagent, a `/clear` that replaces the root session,
 * and one agent that finishes and exits.
 */
const RECORDED: HookPayload[] = [
  hook("pane-a", "SessionStart", "sess-a1", {
    transcriptPath: "/home/u/.claude/a1.jsonl",
  }),
  hook("pane-a", "UserPromptSubmit", "sess-a1"),
  hook("pane-a", "PreToolUse", "sess-a1"),
  hook("pane-b", "SessionStart", "sess-b1"),
  hook("pane-a", "PostToolUse", "sess-a1"),
  hook("pane-b", "UserPromptSubmit", "sess-b1"),
  hook("pane-b", "PermissionRequest", "sess-b1"),
  hook("pane-a", "SubagentStart", "sess-a1", {
    agentId: "sub-1",
    toolUseId: "tool-1",
  }),
  hook("pane-a", "PreToolUse", "sess-a1", { agentId: "sub-1" }),
  hook("pane-a", "SubagentStop", "sess-a1", {
    agentId: "sub-1",
    toolUseId: "tool-1",
  }),
  hook("pane-b", "PreToolUse", "sess-b1"),
  hook("pane-a", "Stop", "sess-a1"),
  hook("pane-b", "PostToolUse", "sess-b1"),
  hook("pane-b", "Stop", "sess-b1"),
  // `/clear` in pane A: a new root session.
  hook("pane-a", "SessionStart", "sess-a2", {
    transcriptPath: "/home/u/.claude/a2.jsonl",
  }),
  hook("pane-a", "UserPromptSubmit", "sess-a2"),
  hook("pane-b", "SessionEnd", "sess-b1"),
  hook("pane-a", "Notification", "sess-a2", {
    notificationKind: "permission_prompt",
  }),
  // Malformed and filtered hooks are in real journals too.
  { paneId: "pane-a", eventType: "Stop" },
  hook("pane-a", "Notification", "sess-a2", {
    notificationKind: "idle_prompt",
  }),
];

/** How much of the journal each reader replays before going live. */
const REPLAYED = 9;

interface Reader {
  agentManager: AgentManager;
  driver: AgentStatusDriver;
  feed: HostHookFeed;
  stop(): void;
}

function replaySource(journal: HookJournal) {
  return async (
    sinceSeq: number,
    opts?: { headOnly?: boolean },
  ): Promise<HookReplay> => ({
    entries: opts?.headOnly ? [] : journal.since(sinceSeq),
    lastSeq: journal.lastSeq,
    epoch: journal.epoch,
  });
}

/**
 * The desktop's reader of a remote host's journal: the pipeline `initApp()`
 * builds, configured as it configures it — the registry's session owner (the
 * remote host) as each pane's host, the renderer's pane contexts (none yet),
 * main's unseen Sets — with its broadcasts and notifications going nowhere.
 * Its cursor starts at the journal's beginning, as for a desktop that met
 * this journal before any of these hooks.
 */
function desktopReader(dir: string, journal: HookJournal): Reader {
  const agentManager = new AgentManager(dir, 90, () => REMOTE_HOST);
  const pipeline = createAgentPipeline(desktopAgentPipelineOptions({
    agentManager,
    paneContexts: new Map(),
    getPaneHostId: () => REMOTE_HOST,
    unseen: new UnseenAgents(),
    broadcastAgent: () => {},
    publishPaneStatus: () => {},
    onStatus: () => {},
    clocks: { monoClock: clock, wallClock: clock, log: () => {} },
  }));
  pipeline.start();
  const store = memoryHookSeqStore();
  store.set(REMOTE_HOST, { seq: 0, epoch: journal.epoch });
  const feed = new HostHookFeed({
    hostId: REMOTE_HOST,
    replay: replaySource(journal),
    store,
    sink: () => pipeline.hookSink,
  });
  return { agentManager, driver: pipeline.driver, feed, stop: pipeline.stop };
}

/** The host server's reader, as `createHostServer` wires it. */
function hostReader(dir: string, journal: HookJournal): Reader {
  const agents = createHostAgents({
    dataDir: dir,
    publish: () => {},
    monoClock: clock,
    wallClock: clock,
    log: () => {},
  });
  agents.start();
  const store = fileHookCursorStore(path.join(dir, "hook-cursor.json"), {
    beforeWrite: () => agents.agentManager.flushNow(),
  });
  store.set(LOCAL_HOST_ID, { seq: 0, epoch: journal.epoch });
  const feed = new HostHookFeed({
    hostId: LOCAL_HOST_ID,
    replay: replaySource(journal),
    store,
    sink: () => agents.hookSink,
  });
  return {
    agentManager: agents.agentManager,
    driver: agents.driver,
    feed,
    stop: agents.stop,
  };
}

/** An agent as both readers must agree on it: all but ids, times and host. */
function comparable(agent: AgentInfo) {
  return {
    agentSessionId: agent.agentSessionId,
    paneId: agent.paneId,
    status: agent.status,
    lastAgentStatus: agent.lastAgentStatus,
    agentKind: agent.agentKind,
    transcriptPath: agent.transcriptPath,
    name: agent.name,
    projectId: agent.projectId,
    workspacePath: agent.workspacePath,
  };
}

function agentsOf(reader: Reader) {
  return reader.agentManager
    .getAllAgents()
    .map(comparable)
    .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
}

describe("two readers of one hook journal", () => {
  let tmp: string;
  let readers: Reader[] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manor-two-readers-"));
  });

  afterEach(() => {
    for (const reader of readers) {
      reader.feed.pause();
      reader.stop();
    }
    readers = [];
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("leave every pane in the same state, replayed and live alike", async () => {
    const journal = new HookJournal(path.join(tmp, "hook-journal.ndjson"));
    journal.open();
    for (const payload of RECORDED.slice(0, REPLAYED)) journal.append(payload);

    const desktop = desktopReader(path.join(tmp, "desktop"), journal);
    const host = hostReader(path.join(tmp, "host"), journal);
    readers = [desktop, host];

    /** Every pane's state and every agent, compared after each step. */
    const expectAgreement = (step: string) => {
      for (const paneId of ["pane-a", "pane-b"]) {
        expect(
          host.driver.getPaneState(paneId),
          `${paneId} after ${step}`,
        ).toEqual(desktop.driver.getPaneState(paneId));
      }
      expect(
        host.driver.getAllPaneStatuses(),
        `statuses after ${step}`,
      ).toEqual(desktop.driver.getAllPaneStatuses());
      expect(agentsOf(host), `agents after ${step}`).toEqual(agentsOf(desktop));
    };

    // Each meets the journal on connect: the first part is a replay.
    await desktop.feed.catchUp();
    await host.feed.catchUp();
    expect(agentsOf(desktop).map((a) => a.agentSessionId)).toEqual([
      "sess-a1",
      "sess-b1",
    ]);
    expectAgreement("the replay");

    // The rest arrives live, a second apart, to both.
    for (const payload of RECORDED.slice(REPLAYED)) {
      now += 1_000;
      const { seq } = journal.append(payload);
      desktop.feed.onLiveEvent(seq, payload);
      host.feed.onLiveEvent(seq, payload);
      expectAgreement(`seq ${seq} (${payload.eventType})`);
    }

    // The time-based rules run too, on both, at the same moments.
    for (let i = 0; i < 3; i++) {
      now += 30_000;
      desktop.driver.tick();
      host.driver.tick();
      expectAgreement(`tick ${i}`);
    }

    expect(desktop.feed.seq).toBe(journal.lastSeq);
    expect(host.feed.seq).toBe(journal.lastSeq);
    for (const paneId of ["pane-a", "pane-b"]) {
      expect(host.driver.getPaneState(paneId)).toBeDefined();
    }

    expect(agentsOf(host).map((a) => a.agentSessionId)).toEqual([
      "sess-a1",
      "sess-a2",
      "sess-b1",
    ]);

    // The one difference by design: the host server is local to itself.
    for (const agent of host.agentManager.getAllAgents()) {
      expect(agent.hostId).toBe(LOCAL_HOST_ID);
    }
    for (const agent of desktop.agentManager.getAllAgents()) {
      expect(agent.hostId).toBe(REMOTE_HOST);
    }
  });
});
