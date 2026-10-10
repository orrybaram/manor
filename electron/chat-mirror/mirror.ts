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
 */

import { LOCAL_HOST_ID } from "../backend/types";
import {
  encodePickerAnswer,
  encodePlanApproval,
  type PickerAnswer,
} from "./picker-keys";
import {
  RemoteTranscriptSource,
  type TranscriptExec,
} from "./remote-transcript-source";
import { TranscriptParser, type ChatEntry } from "./transcript";
import type { TranscriptSource } from "./transcript-source";

/**
 * Why a pane has no chat. `host-offline`: the transcript could not be read
 * just now, most likely because the agent's host is unreachable. `remote` is
 * no longer produced (ADR-216 D4) but stays for renderers that know it.
 */
export type ChatUnavailableReason =
  | "no-agent"
  | "no-transcript"
  | "remote"
  | "host-offline";

/** What `chat.getHistory` answers. */
export type ChatHistory =
  | { ok: true; entries: ChatEntry[] }
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
  transcriptPath: string | null;
}

export interface ChatMirrorDeps {
  /** The pane's agent, or null when the pane has none. */
  agentForPane(paneId: string): PaneAgent | null;
  /** Type into the pane's PTY. */
  write(paneId: string, data: string): void;
  /** Push a new or updated entry to the pane's `chat.entry` subscribers. */
  publish(paneId: string, entry: ChatEntry): void;
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
 * The agent a pane's chat is about: its active agent, or failing that the
 * newest one that ran in it. A pane keeps old, completed agents' records
 * pointing at it, so "the first agent with this paneId" can be the wrong one.
 */
export function pickPaneAgent<
  A extends { paneId: string | null; status: string; createdAt: string },
>(agents: readonly A[], paneId: string): A | null {
  let newest: A | null = null;
  for (const agent of agents) {
    if (agent.paneId !== paneId) continue;
    if (agent.status === "active") return agent;
    if (!newest || agent.createdAt > newest.createdAt) newest = agent;
  }
  return newest;
}

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

class PaneMirror {
  path: string | null = null;
  parser = new TranscriptParser();
  /** Bytes of the file consumed: the end of the last complete line. */
  offset = 0;
  source: TranscriptSource | null = null;
  /** The first read of this path is done; later reads publish what they find. */
  primed = false;
  /** Bumped on every reset, so a read or timer from before it is discarded. */
  generation = 0;
  watched = false;
  unwatch: (() => void) | null = null;
  poll: ReturnType<typeof setInterval> | null = null;
  /** Answers sent and waiting for their `tool_result`, by tool_use id. */
  awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  /** Answers that timed out (D5). */
  needsTerminal = new Set<string>();
  /** Reads run one at a time, in order. */
  queue: Promise<void> = Promise.resolve();
  /**
   * A read queued behind the running one and not started yet. Every trigger
   * until it starts joins it — the "read again" flag — so a burst of hooks
   * during a slow remote read costs one more read, not one each.
   */
  pending: Promise<void> | null = null;
  /** Why the last read failed; null once one succeeds. */
  readError: string | null = null;
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
    m.source = resolved.source;
    this.usePath(paneId, m, resolved.path);
    await this.read(paneId, m);
    if (m.readError !== null) return { ok: false, reason: "host-offline" };
    return { ok: true, entries: this.entries(m) };
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
      this.stopWatching(m);
      return;
    }
    const m = this.ensure(paneId);
    m.watched = true;
    this.sync(paneId, m);
    this.startWatching(paneId, m);
  }

  /**
   * A hook arrived for the pane's agent: its transcript has likely grown
   * (ADR-216 D3). Reads now if somebody is subscribed, else does nothing.
   */
  poke(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m?.watched || !m.path) return;
    void this.read(paneId, m);
  }

  /** The pane's agent changed: re-check its transcript path. */
  agentChanged(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m) return;
    this.sync(paneId, m);
    if (m.watched) this.startWatching(paneId, m);
  }

  /**
   * The pane's session is gone: release its watcher, timers and parsed
   * state. A pane somebody is still subscribed to (its shell was reset in
   * place) keeps only that fact, so the next agent update can start again.
   */
  closePane(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m) return;
    this.stopWatching(m);
    this.reset(m, null);
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
    m.source = resolved.source;
    this.usePath(paneId, m, resolved.path);
    await this.read(paneId, m);
    // The picker cannot be checked against a transcript that cannot be read.
    if (m.readError !== null) return { ok: false, reason: "host-offline" };

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
    const generation = m.generation;
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
      this.stopWatching(m);
      this.reset(m, null);
    }
    this.mirrors.clear();
  }

  private resolve(
    paneId: string,
  ): { ok: true; path: string; source: TranscriptSource } | { ok: false; reason: ChatUnavailableReason } {
    const agent = this.deps.agentForPane(paneId);
    if (!agent) return { ok: false, reason: "no-agent" };
    if (!agent.transcriptPath) return { ok: false, reason: "no-transcript" };
    return {
      ok: true,
      path: agent.transcriptPath,
      source: this.deps.sourceFor(agent),
    };
  }

  private ensure(paneId: string): PaneMirror {
    let m = this.mirrors.get(paneId);
    if (!m) {
      m = new PaneMirror();
      this.mirrors.set(paneId, m);
    }
    return m;
  }

  /** Point the mirror at whatever the pane's agent says now. */
  private sync(paneId: string, m: PaneMirror): void {
    const resolved = this.resolve(paneId);
    if (resolved.ok) m.source = resolved.source;
    this.usePath(paneId, m, resolved.ok ? resolved.path : null);
  }

  private usePath(paneId: string, m: PaneMirror, path: string | null): void {
    if (m.path === path) return;
    const watching = m.unwatch !== null || m.poll !== null;
    this.stopWatching(m);
    this.reset(m, path);
    if (watching || m.watched) this.startWatching(paneId, m);
  }

  /** Forget everything read, and start over at `path`. */
  private reset(m: PaneMirror, path: string | null): void {
    for (const timer of m.awaiting.values()) clearTimeout(timer);
    m.awaiting.clear();
    m.needsTerminal.clear();
    m.generation++;
    m.path = path;
    m.parser = new TranscriptParser();
    m.offset = 0;
    m.primed = false;
    m.readError = null;
  }

  private startWatching(paneId: string, m: PaneMirror): void {
    if (!m.path || m.poll !== null) return;
    const onChange = () => {
      void this.read(paneId, m);
    };
    const watchable = typeof m.source?.watch === "function";
    m.unwatch = m.source?.watch?.(m.path, onChange) ?? null;
    m.poll = setInterval(
      onChange,
      watchable ? this.pollIntervalMs : this.unwatchedPollIntervalMs,
    );
    m.poll.unref?.();
    onChange();
  }

  private stopWatching(m: PaneMirror): void {
    m.unwatch?.();
    m.unwatch = null;
    if (m.poll !== null) clearInterval(m.poll);
    m.poll = null;
  }

  /**
   * Read whatever was appended since the last read, in turn. The promise
   * settles after a read that started after this call. A call while a read
   * is already waiting to start joins that one instead of queueing another.
   */
  private read(paneId: string, m: PaneMirror): Promise<void> {
    if (m.pending) return m.pending;
    const run = () => {
      m.pending = null;
      return this.readNow(paneId, m).catch((err: unknown) => {
        console.error(`[chat-mirror] read failed for ${paneId}:`, err);
      });
    };
    const next = m.queue.then(run, run);
    m.pending = next;
    m.queue = next;
    return next;
  }

  private async readNow(paneId: string, m: PaneMirror): Promise<void> {
    const path = m.path;
    const source = m.source;
    if (!path || !source) return;
    let generation = m.generation;
    for (;;) {
      const result = await source.read(path, m.offset);
      if (generation !== m.generation) return;
      // Keep what was read so far; the next trigger tries again.
      if (!result.ok) {
        m.readError = result.error;
        return;
      }
      // Rewritten from scratch: start over, quietly (`reset` unprimes, so
      // the re-read publishes nothing). The data read was from the wrong
      // offset, so read again from the start.
      if (result.size < m.offset) {
        this.reset(m, path);
        generation = m.generation;
        continue;
      }
      m.readError = null;
      // A line too long to read: step over it, and read on from after it.
      if (result.skip !== undefined && result.skip > 0) {
        m.offset += result.skip;
        continue;
      }
      this.consume(paneId, m, result.data, m.primed);
      m.primed = true;
      return;
    }
  }

  /**
   * Parse every complete line in `data`, which starts at `m.offset`. The
   * offset advances by the byte length of those lines (newlines included);
   * a partial last line is left for the next read to return whole.
   */
  private consume(
    paneId: string,
    m: PaneMirror,
    data: string,
    publish: boolean,
  ): void {
    const end = data.lastIndexOf("\n");
    if (end === -1) return;
    const complete = data.slice(0, end + 1);
    m.offset += Buffer.byteLength(complete, "utf8");
    for (const line of complete.slice(0, -1).split("\n")) {
      for (const entry of m.parser.push(line)) {
        if (!isOpenPicker(entry)) this.settle(m, entry.id);
        if (publish) this.deps.publish(paneId, this.decorate(m, entry));
      }
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
    if (m.generation !== generation || !m.awaiting.has(id)) return;
    // The watcher may be off (nobody subscribed) or simply late: look first.
    // `awaiting` keeps the id until then, so a second answer stays refused.
    await this.read(paneId, m);
    // Settled by that read, or reset while it ran.
    if (m.generation !== generation || !m.awaiting.has(id)) return;
    m.awaiting.delete(id);
    const entry = m.parser.entries().find((e) => e.id === id);
    if (!entry || !isOpenPicker(entry)) return;
    m.needsTerminal.add(id);
    this.deps.publish(paneId, this.decorate(m, entry));
  }

  /** The newest question or plan, answered or not. */
  private newestPicker(m: PaneMirror): ChatEntry | null {
    const entries = m.parser.entries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.kind === "question" || entry.kind === "plan") return entry;
    }
    return null;
  }

  private entries(m: PaneMirror): ChatEntry[] {
    return m.parser.entries().map((e) => this.decorate(m, e));
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
