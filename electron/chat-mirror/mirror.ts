/**
 * The per-pane transcript mirror behind the `chat` bridge namespace
 * (ADR-215 D4, D5).
 *
 * One mirror per pane: it resolves the pane's agent and its `transcriptPath`,
 * reads the JSONL from the start through `TranscriptParser`, then tails it by
 * byte offset. The offset only ever advances by the byte length of complete
 * lines; a partial trailing line is left unconsumed and re-read, with what
 * follows it, once its newline arrives — Claude appends a line in more than
 * one write, and a UTF-8 character can straddle two reads.
 *
 * It watches only while the bridge says somebody is subscribed to the pane's
 * `chat.entry`: the source's change signal plus a 1s poll (a watch on a file
 * misses renames and is unreliable on some filesystems), or, for a source
 * with no change signal (a remote host, ADR-216 D3), a 2s poll and a `poke`
 * on each of the agent's hooks. Parsed state outlives the watch, so the next
 * subscriber catches up from the offset rather than from the start. Reads
 * never overlap, and triggers that land while one is waiting coalesce into it.
 *
 * The path is re-checked on every agent update, every history read and every
 * answer: `/clear` and resume move a pane to a new transcript, and the latest
 * hook wins (ticket 2). A new path resets the parser and re-reads silently —
 * the renderer re-fetches `getHistory` when the agent's `transcriptPath`
 * changes rather than being sent the whole new transcript as events.
 *
 * The transcript is read through a `TranscriptSource` chosen per agent
 * (ADR-216 D1): the local filesystem, or a remote host's `Exec`. A read that
 * fails (the host is offline, the exec failed) changes nothing: the next
 * trigger tries again, and `getHistory` answers `unavailable: "host-offline"`
 * meanwhile. Subscribers keep the entries they already have. A line too long
 * for one read is stepped over without an entry (`TranscriptRead.skip`).
 *
 * The tailing itself (offset, reads, watch and poll) is a `TranscriptStream`
 * (`stream.ts`, ADR-224 D3); a pane mirror owns one, plus the pane-only parts:
 * pickers, skills and the context size.
 */

import { LOCAL_HOST_ID } from "../backend/types";
import type { AgentKind } from "../terminal-host/types";
import { adapterFor } from "./adapters";
import type { TranscriptAdapter } from "./adapters/types";
import { BUILTIN_COMMANDS, type ChatCommand } from "./builtin-commands";
import {
  encodePickerAnswer,
  encodePlanApproval,
  type PickerAnswer,
} from "./picker-keys";
import {
  RemoteTranscriptSource,
  type TranscriptExec,
} from "./remote-transcript-source";
import {
  type ChatEntry,
  type ChatPush,
  type ChatSkill,
} from "./transcript";
import type { TranscriptSource } from "./transcript-source";
import { TranscriptStream } from "./stream";

/**
 * Why a pane has no chat. `host-offline`: the transcript could not be read
 * just now, most likely because the agent's host is unreachable. `remote` is
 * no longer produced (ADR-216 D4) but stays for renderers that know it.
 * `unsupported-agent`: the agent has no transcript adapter yet (ADR-224 D1).
 */
export type ChatUnavailableReason =
  | "no-agent"
  | "unsupported-agent"
  | "no-transcript"
  | "remote"
  | "host-offline";

/** What `chat.getHistory` answers. */
export type ChatHistory =
  | { ok: true; entries: ChatEntry[]; contextTokens: number | null }
  | { ok: false; reason: ChatUnavailableReason };

export type { ChatCommand } from "./builtin-commands";

/** What `chat.getCommands` answers (ADR-217 D3). */
export type ChatCommands =
  | { ok: true; commands: ChatCommand[]; skillsKnown: boolean }
  | { ok: false; reason: ChatUnavailableReason };

/** What the chat can answer a picker with. A plan can only be approved. */
export type ChatAnswer =
  | { kind: "question"; answers: PickerAnswer[] }
  | { kind: "plan-approve" };

/**
 * What `chat.answer` answers.
 *
 * - `stale`: that picker is not the newest open one any more, or an answer
 *   to it is already in flight or timed out. Nothing was typed.
 * - `unsupported`: the encoder refused the answer. Nothing was typed; the
 *   card should send the user to the terminal.
 */
export type ChatAnswerResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "unsupported" | ChatUnavailableReason };

/** The little of an agent the mirror reads. */
export interface PaneAgent {
  /** The host the agent's terminal runs on now (`agentHostId`). */
  hostId: string;
  agentKind: AgentKind;
  transcriptPath: string | null;
}

export interface ChatMirrorDeps {
  /** The pane's agent, or null when the pane has none. */
  agentForPane(paneId: string): PaneAgent | null;
  /** Type into the pane's PTY. */
  write(paneId: string, data: string): void;
  /**
   * Push a new or updated entry, or a context-size update, to the pane's
   * `chat.entry` subscribers.
   */
  publish(paneId: string, entry: ChatPush): void;
  /** Where the agent's transcript is read from (ADR-216 D1). */
  sourceFor(agent: PaneAgent): TranscriptSource;
  /** How long an answer waits for its `tool_result`. Default 8s. */
  answerTimeoutMs?: number;
  /** The poll fallback's interval for a source with `watch`. Default 1s. */
  pollIntervalMs?: number;
  /** The poll's interval for a source without `watch` (a remote host). Default 2s. */
  unwatchedPollIntervalMs?: number;
}

const DEFAULT_ANSWER_TIMEOUT_MS = 8_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_UNWATCHED_POLL_INTERVAL_MS = 2_000;

/**
 * `ChatMirrorDeps.sourceFor` over every host: `local` for this machine, and
 * for a remote host one `RemoteTranscriptSource` (kept per host) reading
 * through whatever `execFor(hostId)` answers at the time of each read, so a
 * host that reconnects with a new backend is picked up.
 */
export function transcriptSources(
  local: TranscriptSource,
  execFor: (hostId: string) => TranscriptExec | null,
): (agent: PaneAgent) => TranscriptSource {
  const remote = new Map<string, RemoteTranscriptSource>();
  return (agent) => {
    if (agent.hostId === LOCAL_HOST_ID) return local;
    let source = remote.get(agent.hostId);
    if (!source) {
      const { hostId } = agent;
      source = new RemoteTranscriptSource(() => execFor(hostId));
      remote.set(hostId, source);
    }
    return source;
  };
}

/**
 * A pane's chat: its own transcript's stream, plus what only a pane has —
 * pickers that can be answered (ADR-224 D3).
 */
class PaneMirror {
  readonly stream: TranscriptStream;
  /**
   * The most recent non-empty skill list. Survives `reset`: `/clear` and
   * resume start a transcript with no listing until its first prompt.
   */
  lastSkills: ChatSkill[] = [];
  /**
   * The context size subscribers were last told of, or that the history
   * carries (ADR-223 D4). A `usage` entry is published only on a change.
   */
  lastContextTokens: number | null = null;
  watched = false;
  /** Answers sent and waiting for their `tool_result`, by tool_use id. */
  awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  /** Answers that timed out (D5). */
  needsTerminal = new Set<string>();

  constructor(
    label: string,
    intervals: { pollIntervalMs: number; unwatchedPollIntervalMs: number },
    hooks: {
      onEntry(m: PaneMirror, entry: ChatEntry, publish: boolean): void;
      onConsumed(m: PaneMirror, publish: boolean): void;
    },
  ) {
    this.stream = new TranscriptStream({
      label,
      ...intervals,
      hooks: {
        onEntry: (entry, publish) => hooks.onEntry(this, entry, publish),
        onConsumed: (publish) => hooks.onConsumed(this, publish),
        onReset: () => this.forget(),
      },
    });
  }

  /** The stream is starting over: nothing it read is in question any more. */
  private forget(): void {
    for (const timer of this.awaiting.values()) clearTimeout(timer);
    this.awaiting.clear();
    this.needsTerminal.clear();
    this.lastContextTokens = null;
  }
}

function isOpenPicker(entry: ChatEntry): boolean {
  if (entry.kind === "question") return entry.answer === null;
  if (entry.kind === "plan") return entry.outcome === null;
  return false;
}

export class ChatMirror {
  private readonly mirrors = new Map<string, PaneMirror>();
  private readonly answerTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly unwatchedPollIntervalMs: number;

  constructor(private readonly deps: ChatMirrorDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.unwatchedPollIntervalMs =
      deps.unwatchedPollIntervalMs ?? DEFAULT_UNWATCHED_POLL_INTERVAL_MS;
  }

  /** The pane's entries so far, after catching up with the file. */
  async getHistory(paneId: string): Promise<ChatHistory> {
    const resolved = this.resolve(paneId);
    if (!resolved.ok) return resolved;
    const m = this.ensure(paneId);
    m.stream.source = resolved.source;
    this.usePath(m, resolved.path, resolved.adapter);
    await m.stream.read();
    if (m.stream.readError !== null) return { ok: false, reason: "host-offline" };
    return {
      ok: true,
      entries: this.entries(m),
      contextTokens: m.stream.parser.contextTokens(),
    };
  }

  /** Built-in commands plus the session's skills (ADR-217 D3). */
  async getCommands(paneId: string): Promise<ChatCommands> {
    const resolved = this.resolve(paneId);
    if (!resolved.ok) return resolved;
    const m = this.ensure(paneId);
    m.stream.source = resolved.source;
    this.usePath(m, resolved.path, resolved.adapter);
    await m.stream.read();
    if (m.stream.readError !== null) return { ok: false, reason: "host-offline" };

    const parser = m.stream.parser;
    const listed = parser.hasSkillListing();
    const skills = listed ? parser.skills() : m.lastSkills;
    const byName = new Map<string, ChatCommand>();
    for (const c of BUILTIN_COMMANDS) byName.set(c.name, c);
    for (const s of skills) {
      byName.set(s.name, {
        name: s.name,
        description: s.description,
        source: "skill",
      });
    }
    const commands = [...byName.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    return { ok: true, commands, skillsKnown: listed || m.lastSkills.length > 0 };
  }

  /**
   * Whether anybody is subscribed to the pane's `chat.entry`. The bridge
   * calls this on the first subscribe and the last unsubscribe.
   */
  setWatched(paneId: string, watched: boolean): void {
    if (!watched) {
      const m = this.mirrors.get(paneId);
      if (!m) return;
      m.watched = false;
      m.stream.stopWatching();
      return;
    }
    const m = this.ensure(paneId);
    m.watched = true;
    this.sync(paneId, m);
    m.stream.startWatching();
  }

  /**
   * A hook arrived for the pane's agent: its transcript has likely grown
   * (ADR-216 D3). Reads now if somebody is subscribed, else does nothing.
   */
  poke(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m?.watched || !m.stream.path) return;
    void m.stream.read();
  }

  /** The pane's agent changed: re-check its transcript path. */
  agentChanged(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m) return;
    this.sync(paneId, m);
    if (m.watched) m.stream.startWatching();
  }

  /**
   * The pane's session is gone: release its watcher, timers and parsed
   * state. A pane somebody is still subscribed to (its shell was reset in
   * place) keeps only that fact, so the next agent update can start again.
   */
  closePane(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m) return;
    m.stream.stopWatching();
    m.stream.reset(null);
    if (!m.watched) this.mirrors.delete(paneId);
  }

  /**
   * Answer the pane's open picker by typing into its PTY (D5).
   *
   * Refused as `stale` unless `toolUseId` is the newest question/plan, still
   * open, with no answer already in flight: a double tap, or a picker the
   * desktop already answered, must never type into whatever screen is next.
   * Refused as `unsupported`, with nothing typed, if the encoder cannot
   * express the answer. If no `tool_result` follows within the timeout, the
   * entry is published again with `needsTerminal: true`, and never retried.
   */
  async answer(
    paneId: string,
    toolUseId: string,
    answer: ChatAnswer,
  ): Promise<ChatAnswerResult> {
    const resolved = this.resolve(paneId);
    if (!resolved.ok) return resolved;
    const m = this.ensure(paneId);
    m.stream.source = resolved.source;
    this.usePath(m, resolved.path, resolved.adapter);
    await m.stream.read();
    // The picker cannot be checked against a transcript that cannot be read.
    if (m.stream.readError !== null) return { ok: false, reason: "host-offline" };

    // Synchronous from here to the write: a second call waiting on the same
    // read sees this one's `awaiting` entry.
    const target = this.newestPicker(m);
    if (
      !target ||
      target.id !== toolUseId ||
      !isOpenPicker(target) ||
      m.awaiting.has(toolUseId) ||
      m.needsTerminal.has(toolUseId)
    ) {
      return { ok: false, reason: "stale" };
    }

    let bytes: string;
    try {
      if (answer.kind === "plan-approve") {
        if (target.kind !== "plan") throw new Error("not a plan");
        bytes = encodePlanApproval();
      } else {
        if (target.kind !== "question") throw new Error("not a question");
        bytes = encodePickerAnswer(target.questions, answer.answers);
      }
    } catch {
      return { ok: false, reason: "unsupported" };
    }

    this.deps.write(paneId, bytes);
    const generation = m.stream.generation;
    m.awaiting.set(
      toolUseId,
      setTimeout(() => {
        void this.expire(paneId, m, toolUseId, generation);
      }, this.answerTimeoutMs),
    );
    return { ok: true };
  }

  /** Release everything. The app is quitting. */
  dispose(): void {
    for (const m of this.mirrors.values()) {
      m.stream.stopWatching();
      m.stream.reset(null);
    }
    this.mirrors.clear();
  }

  private resolve(
    paneId: string,
  ):
    | { ok: true; path: string; source: TranscriptSource; adapter: TranscriptAdapter }
    | { ok: false; reason: ChatUnavailableReason } {
    const agent = this.deps.agentForPane(paneId);
    if (!agent) return { ok: false, reason: "no-agent" };
    const adapter = adapterFor(agent.agentKind);
    if (!adapter) return { ok: false, reason: "unsupported-agent" };
    if (!agent.transcriptPath) return { ok: false, reason: "no-transcript" };
    return {
      ok: true,
      path: agent.transcriptPath,
      source: this.deps.sourceFor(agent),
      adapter,
    };
  }

  private ensure(paneId: string): PaneMirror {
    let m = this.mirrors.get(paneId);
    if (!m) {
      m = new PaneMirror(
        paneId,
        {
          pollIntervalMs: this.pollIntervalMs,
          unwatchedPollIntervalMs: this.unwatchedPollIntervalMs,
        },
        {
          onEntry: (pane, entry, publish) => {
            if (!isOpenPicker(entry)) this.settle(pane, entry.id);
            if (publish) this.deps.publish(paneId, this.decorate(pane, entry));
          },
          onConsumed: (pane, publish) => this.consumed(paneId, pane, publish),
        },
      );
      this.mirrors.set(paneId, m);
    }
    return m;
  }

  /** Point the mirror at whatever the pane's agent says now. */
  private sync(paneId: string, m: PaneMirror): void {
    const resolved = this.resolve(paneId);
    if (resolved.ok) m.stream.source = resolved.source;
    this.usePath(
      m,
      resolved.ok ? resolved.path : null,
      resolved.ok ? resolved.adapter : m.stream.adapter,
    );
  }

  private usePath(
    m: PaneMirror,
    path: string | null,
    adapter: TranscriptAdapter,
  ): void {
    m.stream.usePath(path, adapter, m.watched);
  }

  /** After a batch of lines: the context size and the skill listing. */
  private consumed(paneId: string, m: PaneMirror, publish: boolean): void {
    const parser = m.stream.parser;
    const tokens = parser.contextTokens();
    if (tokens !== m.lastContextTokens) {
      m.lastContextTokens = tokens;
      if (publish && tokens !== null) {
        this.deps.publish(paneId, {
          kind: "usage",
          id: "usage",
          ts: new Date().toISOString(),
          contextTokens: tokens,
        });
      }
    }
    if (parser.hasSkillListing()) {
      const skills = parser.skills();
      if (skills.length > 0) m.lastSkills = skills;
    }
  }

  /** A picker got its `tool_result`: its answer is no longer in question. */
  private settle(m: PaneMirror, id: string): void {
    const timer = m.awaiting.get(id);
    if (timer !== undefined) clearTimeout(timer);
    m.awaiting.delete(id);
    m.needsTerminal.delete(id);
  }

  private async expire(
    paneId: string,
    m: PaneMirror,
    id: string,
    generation: number,
  ): Promise<void> {
    if (m.stream.generation !== generation || !m.awaiting.has(id)) return;
    // The watcher may be off (nobody subscribed) or simply late: look first.
    // `awaiting` keeps the id until then, so a second answer stays refused.
    await m.stream.read();
    // Settled by that read, or reset while it ran.
    if (m.stream.generation !== generation || !m.awaiting.has(id)) return;
    m.awaiting.delete(id);
    const entry = m.stream.parser.entries().find((e) => e.id === id);
    if (!entry || !isOpenPicker(entry)) return;
    m.needsTerminal.add(id);
    this.deps.publish(paneId, this.decorate(m, entry));
  }

  /** The newest question or plan, answered or not. */
  private newestPicker(m: PaneMirror): ChatEntry | null {
    const entries = m.stream.parser.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === "question" || entry.kind === "plan") return entry;
    }
    return null;
  }

  private entries(m: PaneMirror): ChatEntry[] {
    return m.stream.parser.entries().map((e) => this.decorate(m, e));
  }

  private decorate(m: PaneMirror, entry: ChatEntry): ChatEntry {
    if (
      (entry.kind === "question" || entry.kind === "plan") &&
      m.needsTerminal.has(entry.id) &&
      isOpenPicker(entry)
    ) {
      return { ...entry, needsTerminal: true };
    }
    return entry;
  }
}
