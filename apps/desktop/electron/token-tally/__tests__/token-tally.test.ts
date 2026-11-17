import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TokenTally } from "../token-tally";

function assistantLine(
  id: string,
  input: number,
  output: number,
  cacheRead = 50_000,
  timestamp = new Date().toISOString(),
): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      id,
      role: "assistant",
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  });
}

describe("TokenTally", () => {
  let dataDir: string;
  let projects: string;
  let counted: number[];
  const tallies: TokenTally[] = [];

  /**
   * A tally that first ran a second ago, so a transcript written now is newer
   * even by the filesystem's coarser clock.
   */
  function seedSince(): void {
    const file = path.join(dataDir, "token-tally.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, since: Date.now() - 1000, markers: {} }));
  }

  function makeTally(): TokenTally {
    const tally = new TokenTally({ dataDir, record: (n) => counted.push(n) });
    tallies.push(tally);
    return tally;
  }
  const total = () => counted.reduce((a, b) => a + b, 0);

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tally-data-"));
    projects = fs.mkdtempSync(path.join(os.tmpdir(), "token-tally-projects-"));
    counted = [];
    seedSince();
  });
  afterEach(() => {
    for (const tally of tallies.splice(0)) tally.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(projects, { recursive: true, force: true });
  });

  it("counts a new transcript from its start, and only new lines after a restart", async () => {
    const tally = makeTally();
    const transcript = path.join(projects, "sess.jsonl");
    fs.writeFileSync(transcript, `${assistantLine("msg_1", 10, 5)}\n${assistantLine("msg_1", 10, 5)}\n`);
    const agent = { agentKind: "claude" as const, transcriptPath: transcript };

    await tally.tally(agent);
    expect(total()).toBe(15);
    await tally.tally(agent);
    expect(total()).toBe(15);
    tally.dispose();

    fs.appendFileSync(transcript, `${assistantLine("msg_2", 1, 2)}\n`);
    const restarted = makeTally();
    await restarted.tally(agent);
    expect(total()).toBe(18);
    // The marker file holds hashes, never the path.
    expect(fs.readFileSync(path.join(dataDir, "token-tally.json"), "utf8")).not.toContain(projects);
  });

  it("counts a session's subagent transcripts, each once", async () => {
    const tally = makeTally();
    const transcript = path.join(projects, "sess.jsonl");
    fs.writeFileSync(transcript, `${assistantLine("msg_1", 10, 0)}\n`);
    const sub = path.join(projects, "sess", "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "agent-a.jsonl"), `${assistantLine("msg_a", 100, 0)}\n`);
    const agent = { agentKind: "claude" as const, transcriptPath: transcript };

    await tally.tally(agent);
    expect(total()).toBe(110);
    fs.writeFileSync(path.join(sub, "agent-b.jsonl"), `${assistantLine("msg_b", 1000, 0)}\n`);
    fs.appendFileSync(path.join(sub, "agent-a.jsonl"), `${assistantLine("msg_a2", 1, 0)}\n`);
    await tally.tally(agent);
    expect(total()).toBe(1111);
  });

  it("starts a transcript from before its first run at its end, and a newer one at its start", async () => {
    fs.rmSync(path.join(dataDir, "token-tally.json"));
    const old = path.join(projects, "old.jsonl");
    fs.writeFileSync(old, `${assistantLine("msg_old", 1000, 1000)}\n`);
    // The tally's first run is after `old` was created.
    // (with room for the filesystem's coarser clock)
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tally = makeTally();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const fresh = path.join(projects, "new.jsonl");
    fs.writeFileSync(fresh, `${assistantLine("msg_new", 3, 4)}\n`);

    await tally.tally({ agentKind: "claude", transcriptPath: old });
    expect(total()).toBe(0);
    await tally.tally({ agentKind: "claude", transcriptPath: fresh });
    expect(total()).toBe(7);

    fs.appendFileSync(old, `${assistantLine("msg_old2", 2, 2)}\n`);
    await tally.tally({ agentKind: "claude", transcriptPath: old });
    expect(total()).toBe(11);
  });

  it("counts only a forked transcript's own lines, not the history copied into it", async () => {
    const tally = makeTally();
    const fork = path.join(projects, "fork.jsonl");
    const copied = "2026-10-31T09:00:00.000Z";
    fs.writeFileSync(
      fork,
      `${assistantLine("msg_old1", 500, 500, 0, copied)}\n${assistantLine("msg_old2", 500, 500, 0, copied)}\n` +
        `${assistantLine("msg_new", 3, 4)}\n`,
    );
    await tally.tally({ agentKind: "claude", transcriptPath: fork });
    expect(total()).toBe(7);
  });

  it("counts nothing old in an old transcript re-created after the first run", async () => {
    const tally = makeTally();
    const recreated = path.join(projects, "recreated.jsonl");
    fs.writeFileSync(recreated, `${assistantLine("msg_old", 1000, 1000, 0, "2026-10-31T09:00:00.000Z")}\n`);
    await tally.tally({ agentKind: "claude", transcriptPath: recreated });
    expect(total()).toBe(0);
    fs.appendFileSync(recreated, `${assistantLine("msg_new", 1, 1)}\n`);
    await tally.tally({ agentKind: "claude", transcriptPath: recreated });
    expect(total()).toBe(2);
  });

  it("gives a pane's old transcript a last read when it moves to a new one", async () => {
    const tally = makeTally();
    const before = path.join(projects, "before.jsonl");
    const after = path.join(projects, "after.jsonl");
    fs.writeFileSync(before, `${assistantLine("msg_1", 10, 0)}\n`);
    await tally.tally({ id: "agent-1", paneId: "pane-1", agentKind: "claude", transcriptPath: before });
    expect(total()).toBe(10);

    // The turn's last line lands after its tally; then /clear starts a new transcript.
    fs.appendFileSync(before, `${assistantLine("msg_2", 5, 0)}\n`);
    fs.writeFileSync(after, `${assistantLine("msg_3", 1, 0)}\n`);
    await tally.tally({ id: "agent-2", paneId: "pane-1", agentKind: "claude", transcriptPath: after });
    expect(total()).toBe(16);
  });

  it("tallies Codex and pi agents by their own readers", async () => {
    const tally = makeTally();
    const rollout = path.join(projects, "rollout.jsonl");
    const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 };
    fs.writeFileSync(
      rollout,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: usage } },
      })}\n`,
    );
    const pi = path.join(projects, "pi.jsonl");
    fs.writeFileSync(
      pi,
      `${JSON.stringify({
        type: "message",
        id: "e1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 99, cacheWrite: 3 } },
      })}\n`,
    );
    await tally.tally({ agentKind: "codex", transcriptPath: rollout });
    await tally.tally({ agentKind: "pi", transcriptPath: pi });
    expect(counted).toEqual([65, 6]);
  });

  it("never overlaps reads of one transcript", async () => {
    const tally = makeTally();
    const transcript = path.join(projects, "sess.jsonl");
    fs.writeFileSync(transcript, `${assistantLine("msg_1", 10, 10)}\n`);
    const agent = { agentKind: "claude" as const, transcriptPath: transcript };
    await Promise.all([tally.tally(agent), tally.tally(agent), tally.tally(agent)]);
    expect(total()).toBe(20);
  });

  it("ignores agent kinds without a reader and agents without a transcript", async () => {
    const tally = new TokenTally({ dataDir, record: (n) => counted.push(n), readers: {} });
    tallies.push(tally);
    const transcript = path.join(projects, "sess.jsonl");
    fs.writeFileSync(transcript, `${assistantLine("msg_1", 10, 10)}\n`);
    await tally.tally({ agentKind: "claude", transcriptPath: transcript });
    await makeTally().tally({ agentKind: "claude", transcriptPath: null });
    await tally.tally({ agentKind: "claude", transcriptPath: null });
    expect(counted).toEqual([]);
  });

  it("prunes markers untouched for 35 days", async () => {
    let now = Date.now();
    const transcript = path.join(projects, "sess.jsonl");
    fs.writeFileSync(transcript, `${assistantLine("msg_1", 1, 1)}\n`);
    const tally = new TokenTally({ dataDir, record: (n) => counted.push(n), now: () => now });
    tallies.push(tally);
    await tally.tally({ agentKind: "claude", transcriptPath: transcript });
    tally.dispose();
    const markers = () =>
      Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir, "token-tally.json"), "utf8")).markers);
    expect(markers()).toHaveLength(1);

    now += 36 * 24 * 60 * 60 * 1000;
    const later = new TokenTally({ dataDir, record: (n) => counted.push(n), now: () => now });
    tallies.push(later);
    later.flushNow();
    expect(markers()).toHaveLength(0);
  });
});
