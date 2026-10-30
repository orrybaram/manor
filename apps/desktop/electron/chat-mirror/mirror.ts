/**
 * The per-pane transcript mirror behind the `chat` bridge namespace.
 *
 * One mirror per pane: it resolves the pane's agent and its `transcriptPath`,
 * reads the JSONL from the start through the agent's parser, then tails it by
 * byte offset. The offset only ever advances by the byte length of complete
 * lines; a partial trailing line is left unconsumed and re-read, with what
 * follows it, once its newline arrives — Claude appends a line in more than
 * one write, and a UTF-8 character can straddle two reads.
 *
 * It watches only while the bridge says somebody is subscribed to the pane's
 * `chat.entry`: the source's change signal plus a 1s poll (a watch on a file
 * misses renames and is unreliable on some filesystems), or, for a source
 * with no change signal (a remote host), a 2s poll and a `poke`
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
 * The transcript is read through a `TranscriptSource` chosen per agent:
 * the local filesystem, or a remote host's `Exec`. A read that
 * fails (the host is offline, the exec failed) changes nothing: the next
 * trigger tries again, and `getHistory` answers `unavailable: "host-offline"`
 * meanwhile. Subscribers keep the entries they already have. A line too long
 * to read is stepped over (`TranscriptRead.skip`); the parser settles the
 * tool it answered, if it can tell which.
 *
 * The tailing itself (offset, reads, watch and poll, the context size) is a
 * `TranscriptStream` (`stream.ts`); a pane mirror owns one for its
 * own transcript, one per task somebody opened, and the pane-only parts:
 * pickers and skills. Who is subscribed is the bridge's fact, kept apart from
 * the streams, so a pane's streams can be dropped and rebuilt under it.
 */

import { agentChat } from "../../src/lib/agent-chat";
import type { AgentKind } from "../terminal-host/types";
import { adapterFor } from "./adapters";
import { claudeAdapter } from "./adapters/claude";
import type { TranscriptAdapter } from "./adapters/types";
import { BUILTIN_COMMANDS, type ChatCommand } from "./builtin-commands";
import {
  encodePickerAnswer,
  encodePlanApproval,
  type PickerAnswer,
} from "./picker-keys";
import { chatTaskKey } from "./task-key";
import {
  type ChatEntry,
  type ChatPush,
  type ChatSkill,
  type ChatTaskEntry,
  type ChatTurnState,
} from "./transcript";
import type { TranscriptSource } from "./transcript-source";
import { TranscriptStream, type TranscriptTarget } from "./stream";

/**
 * Why a pane has no chat. `host-offline`: the transcript could not be read
 * just now, most likely because the agent's host is unreachable. `remote` is
 * no longer produced but stays for renderers that know it.
 * `unsupported-agent`: the agent has no transcript adapter yet.
 */
export type ChatUnavailableReason =
  | "no-agent"
  | "unsupported-agent"
  | "no-transcript"
  | "remote"
  | "host-offline";

/** What `chat.getHistory` answers. */
export type ChatHistory =
  | {
      ok: true;
      entries: ChatEntry[];
      contextTokens: number | null;
      /**
       * The pane's turn as its transcript tells it; null until it says.
       * Absent from a task's history, whose transcript is all sidechain.
       */
      turnState?: ChatTurnState | null;
    }
  | { ok: false; reason: ChatUnavailableReason };

export type { ChatCommand } from "./builtin-commands";

/** What `chat.getCommands` answers. */
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
 * - `unsupported`: the encoder refused the answer, or the agent's kind
 *   can't be answered through its PTY (`agentChat().answersPickers`).
 *   Nothing was typed; the card should send the user to the terminal.
 */
export type ChatAnswerResult =
  | { ok: true }
  | { ok: false; reason: "stale" | "unsupported" | ChatUnavailableReason };

/** How the chat types into a pane's agent (`chat.send`, `chat.interrupt`). */
export interface ChatInput {
  /** The writes that type and submit a prompt, a pause between each. */
  promptWrites(text: string): string[];
  /** The writes that stop a turn, in order. */
  interruptKeys: readonly string[];
}

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
   * Push a new or updated entry, or a context-size or turn-state update, to the pane's
   * `chat.entry` subscribers.
   */
  publish(paneId: string, entry: ChatPush): void;
  /**
   * Push a new or updated entry, or a context-size update, of one task's own
   * transcript to its `chat.taskEntry` subscribers.
   */
  publishTask(paneId: string, taskId: string, entry: ChatPush): void;
  /** Where the agent's transcript is read from. */
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

type StreamIntervals = { pollIntervalMs: number; unwatchedPollIntervalMs: number };

/**
 * A pane's chat: its own transcript's stream, plus what only a pane has —
 * pickers that can be answered, the last skill list, and the streams of the
 * tasks somebody opened.
 */
class PaneMirror {
  readonly stream: TranscriptStream;
  /**
   * The most recent non-empty skill list of a transcript this pane has left:
   * `/clear` and resume start one with no listing until its first prompt.
   */
  lastSkills: ChatSkill[] = [];
  /** Answers sent and waiting for their `tool_result`, by tool_use id. */
  awaiting = new Map<string, ReturnType<typeof setTimeout>>();
  /** Answers that timed out. */
  needsTerminal = new Set<string>();
  /** Tasks' own transcripts, by task (tool_use) id. */
  children = new Map<string, TranscriptStream>();

  constructor(
    label: string,
    adapter: TranscriptAdapter,
    intervals: StreamIntervals,
    onPush: (m: PaneMirror, push: ChatPush, publish: boolean) => void,
  ) {
    this.stream = new TranscriptStream({
      label,
      adapter,
      ...intervals,
      onPush: (push, publish) => onPush(this, push, publish),
      onReset: () => this.forget(),
    });
  }

  /** The stream is starting over: nothing it read is in question any more. */
  private forget(): void {
    const { parser } = this.stream;
    if (parser.hasSkillListing()) {
      const skills = parser.skills();
      if (skills.length > 0) this.lastSkills = skills;
    }
    for (const timer of this.awaiting.values()) clearTimeout(timer);
    this.awaiting.clear();
    this.needsTerminal.clear();
    // A new transcript, or this one rewritten: its tasks are not these.
    for (const child of this.children.values()) child.release();
    this.children.clear();
  }

  /** Stop and forget one task's stream. */
  dropChild(taskId: string): void {
    this.children.get(taskId)?.release();
    this.children.delete(taskId);
  }
}

function isOpenPicker(entry: ChatEntry): boolean {
  if (entry.kind === "question") return entry.answer === null && entry.declined !== true;
  if (entry.kind === "plan") return entry.outcome === null;
  return false;
}

type Resolved =
  | ({ ok: true; kind: AgentKind } & TranscriptTarget)
  | { ok: false; reason: ChatUnavailableReason };

export class ChatMirror {
  private readonly mirrors = new Map<string, PaneMirror>();
  /** Panes somebody is subscribed to (`chat.entry`). */
  private readonly watchedPanes = new Set<string>();
  /** Tasks somebody is subscribed to (`chat.taskEntry`), by `chatTaskKey`. */
  private readonly watchedTasks = new Set<string>();
  private readonly answerTimeoutMs: number;
  private readonly intervals: StreamIntervals;

  constructor(private readonly deps: ChatMirrorDeps) {
    this.answerTimeoutMs = deps.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.intervals = {
      pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      unwatchedPollIntervalMs:
        deps.unwatchedPollIntervalMs ?? DEFAULT_UNWATCHED_POLL_INTERVAL_MS,
    };
  }

  /** The pane's entries so far, after catching up with the file. */
  async getHistory(paneId: string): Promise<ChatHistory> {
    const caught = await this.catchUp(paneId);
    if (!caught.ok) return caught;
    const { m } = caught;
    return {
      ok: true,
      entries: m.stream.parser.entries().map((e) => this.decorate(m, e)),
      contextTokens: m.stream.parser.contextTokens(),
      turnState: m.stream.parser.turnState(),
    };
  }

  /**
   * A task's own transcript so far, after catching up with the
   * pane's (to find the task) and then with the task's. `no-transcript` when
   * the task is unknown, or its agent writes it none.
   */
  async getTaskHistory(paneId: string, taskId: string): Promise<ChatHistory> {
    const caught = await this.catchUp(paneId);
    if (!caught.ok) return caught;
    const child = this.pointChild(paneId, caught.m, taskId);
    if (!child) return { ok: false, reason: "no-transcript" };
    await child.read();
    if (child.readError !== null) return { ok: false, reason: "host-offline" };
    return {
      ok: true,
      entries: child.parser.entries(),
      contextTokens: child.parser.contextTokens(),
    };
  }

  /**
   * The `/` menu the agent's kind offers (`agentChat().commands`): for
   * Claude, its built-in commands plus the session's skills; else none.
   */
  async getCommands(paneId: string): Promise<ChatCommands> {
    const caught = await this.catchUp(paneId);
    if (!caught.ok) return caught;
    const { m } = caught;
    if (agentChat(caught.kind).commands !== "claude") {
      return { ok: true, commands: [], skillsKnown: true };
    }

    const listed = m.stream.parser.hasSkillListing();
    const skills = listed ? m.stream.parser.skills() : m.lastSkills;
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
      this.watchedPanes.delete(paneId);
      this.mirrors.get(paneId)?.stream.stopWatching();
      return;
    }
    this.watchedPanes.add(paneId);
    this.sync(paneId)?.stream.startWatching();
  }

  /**
   * Whether anybody is subscribed to one task's `chat.taskEntry`: `setWatched`'s mechanics, for the task's own transcript. The task is
   * found in the pane's transcript; one not read yet (or whose agentId is not
   * known yet) is tailed when its entry turns up. Unwatching drops the task's
   * stream: the next subscriber reads it again.
   */
  setTaskWatched(paneId: string, taskId: string, watched: boolean): void {
    const key = chatTaskKey(paneId, taskId);
    if (!watched) {
      this.watchedTasks.delete(key);
      this.mirrors.get(paneId)?.dropChild(taskId);
      return;
    }
    this.watchedTasks.add(key);
    const m = this.sync(paneId);
    if (!m) return;
    this.pointChild(paneId, m, taskId)?.startWatching();
    void m.stream.read();
  }

  /**
   * A hook arrived for the pane's agent: its transcript has likely grown
   * and so may its tasks' (a subagent's hooks arrive as the
   * root session's). Reads each that somebody is subscribed to.
   */
  poke(paneId: string): void {
    const m = this.mirrors.get(paneId);
    if (!m) return;
    if (this.watchedPanes.has(paneId)) void m.stream.read();
    for (const [taskId, child] of m.children) {
      if (this.watchedTasks.has(chatTaskKey(paneId, taskId))) void child.read();
    }
  }

  /** The pane's agent changed: re-check its transcript path. */
  agentChanged(paneId: string): void {
    if (!this.mirrors.has(paneId) && !this.watchedPanes.has(paneId)) return;
    const m = this.sync(paneId);
    if (m && this.watchedPanes.has(paneId)) m.stream.startWatching();
  }

  /**
   * The pane's session is gone: release its watchers, timers and parsed
   * state. Its subscribers stay subscribed, so the next agent update can
   * start again.
   */
  closePane(paneId: string): void {
    this.mirrors.get(paneId)?.stream.release();
    this.mirrors.delete(paneId);
  }

  /**
   * Answer the pane's open picker by typing into its PTY.
   *
   * Refused as `stale` unless `toolUseId` is the newest question/plan, still
   * open, with no answer already in flight: a double tap, or a picker the
   * desktop already answered, must never type into whatever screen is next.
   * Refused as `unsupported`, with nothing typed, if the agent's kind can't
   * be answered through the PTY or the encoder cannot express the answer. If no `tool_result` follows within the timeout, the
   * entry is published again with `needsTerminal: true`, and never retried.
   */
  async answer(
    paneId: string,
    toolUseId: string,
    answer: ChatAnswer,
  ): Promise<ChatAnswerResult> {
    // The picker cannot be checked against a transcript that cannot be read.
    const caught = await this.catchUp(paneId);
    if (!caught.ok) return caught;
    const { m } = caught;
    // An agent whose pickers can't be driven from the PTY is answered in its terminal.
    if (!agentChat(caught.kind).answersPickers) {
      return { ok: false, reason: "unsupported" };
    }

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

  /**
   * How to type into the pane's agent: its adapter's prompt and its kind's
   * Stop keys. A pane whose agent the mirror can't see (none yet, before
   * the first prompt) is typed into as Claude's, as it always was.
   */
  input(paneId: string): ChatInput {
    const kind = this.deps.agentForPane(paneId)?.agentKind ?? "claude";
    const adapter = adapterFor(kind) ?? claudeAdapter;
    return {
      promptWrites: (text) => adapter.promptWrites(text),
      interruptKeys: agentChat(kind).interruptKeys,
    };
  }

  /** Release everything. The app is quitting. */
  dispose(): void {
    for (const m of this.mirrors.values()) m.stream.release();
    this.mirrors.clear();
    this.watchedPanes.clear();
    this.watchedTasks.clear();
  }

  private resolve(paneId: string): Resolved {
    const agent = this.deps.agentForPane(paneId);
    if (!agent) return { ok: false, reason: "no-agent" };
    const adapter = adapterFor(agent.agentKind);
    if (!adapter) return { ok: false, reason: "unsupported-agent" };
    if (!agent.transcriptPath) return { ok: false, reason: "no-transcript" };
    return {
      ok: true,
      kind: agent.agentKind,
      path: agent.transcriptPath,
      adapter,
      source: this.deps.sourceFor(agent),
    };
  }

  /**
   * Point the pane's mirror at whatever its agent says now, creating the
   * mirror if it has something to read. Null when it has not.
   */
  private sync(paneId: string): PaneMirror | null {
    const resolved = this.resolve(paneId);
    if (resolved.ok) return this.point(paneId, resolved);
    this.mirrors.get(paneId)?.stream.point(null, false);
    return null;
  }

  /** The pane's mirror, created if need be, pointed at `target`. */
  private point(paneId: string, target: TranscriptTarget): PaneMirror {
    let m = this.mirrors.get(paneId);
    if (!m) {
      m = new PaneMirror(paneId, target.adapter, this.intervals, (pane, push, publish) =>
        this.onPanePush(paneId, pane, push, publish),
      );
      this.mirrors.set(paneId, m);
    }
    m.stream.point(target, this.watchedPanes.has(paneId));
    return m;
  }

  /**
   * Point the pane's mirror at its agent's transcript and read that to its
   * end: what every read of the chat starts with.
   */
  private async catchUp(
    paneId: string,
  ): Promise<
    { ok: true; m: PaneMirror; kind: AgentKind } | { ok: false; reason: ChatUnavailableReason }
  > {
    const resolved = this.resolve(paneId);
    if (!resolved.ok) return resolved;
    const m = this.point(paneId, resolved);
    await m.stream.read();
    if (m.stream.readError !== null) return { ok: false, reason: "host-offline" };
    // The kind as it was when the read began: the agent may be gone by now.
    return { ok: true, m, kind: resolved.kind };
  }

  /** What the pane's stream found: publish it, and settle what it answers. */
  private onPanePush(paneId: string, m: PaneMirror, push: ChatPush, publish: boolean): void {
    if (push.kind === "usage" || push.kind === "turn") {
      if (publish) this.deps.publish(paneId, push);
      return;
    }
    if (!isOpenPicker(push)) this.settle(m, push.id);
    if (publish) this.deps.publish(paneId, this.decorate(m, push));
    // A watched task whose transcript was not known yet (its agentId arrives
    // with its tool_result) can be tailed now.
    if (push.kind === "task" && this.watchedTasks.has(chatTaskKey(paneId, push.id))) {
      this.pointChild(paneId, m, push.id)?.startWatching();
    }
  }

  /** Where the task's own transcript is, by the pane's adapter; null if none. */
  private childPath(m: PaneMirror, task: ChatTaskEntry): string | null {
    const parentPath = m.stream.path;
    return parentPath ? m.stream.adapter.childTranscriptPath(parentPath, task) : null;
  }

  /**
   * The task's stream, created or re-pointed at wherever the adapter says
   * its transcript is now; null when it has none.
   */
  private pointChild(paneId: string, m: PaneMirror, taskId: string): TranscriptStream | null {
    const task = m.stream.parser.entry(taskId);
    const path = task?.kind === "task" ? this.childPath(m, task) : null;
    const source = m.stream.source;
    if (!path || !source) return null;
    let child = m.children.get(taskId);
    if (!child) {
      child = new TranscriptStream({
        label: `${paneId} task ${taskId}`,
        adapter: m.stream.adapter,
        child: true,
        ...this.intervals,
        onPush: (push, publish) => {
          if (publish) this.deps.publishTask(paneId, taskId, push);
        },
      });
      m.children.set(taskId, child);
    }
    // The task's transcript is on the same host, read the same way.
    child.point(
      { path, adapter: m.stream.adapter, source },
      this.watchedTasks.has(chatTaskKey(paneId, taskId)),
    );
    return child;
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
    const entry = m.stream.parser.entry(id);
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

  /**
   * What the parser can't know: a picker that timed out, and whether
   * the adapter finds a task its own transcript.
   */
  private decorate(m: PaneMirror, entry: ChatEntry): ChatEntry {
    if (entry.kind === "task") {
      return { ...entry, hasTranscript: this.childPath(m, entry) !== null };
    }
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
