/**
 * The phone chat view's entry list, kept as pure functions so the view's
 * ordering and "which picker can be answered" rules are testable without a
 * DOM.
 */

import type { AgentStatus, ChatEntry, ChatTaskEntry } from "../../../electron.d";

/** Add `entry`, or replace the one with its id in place. Updates keep their position. */
export function upsertEntry(
  entries: readonly ChatEntry[],
  entry: ChatEntry,
): ChatEntry[] {
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index === -1) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * Lay a fetched history under entries that arrived live before it did.
 *
 * The subscription is opened first so nothing published in between is lost
 * (ticket 4). The history is the base, in transcript order; a live entry it
 * already holds keeps the history's copy, and one it doesn't is appended.
 */
export function mergeHistory(
  history: readonly ChatEntry[],
  live: readonly ChatEntry[],
): ChatEntry[] {
  const known = new Set(history.map((e) => e.id));
  return [...history, ...live.filter((e) => !known.has(e.id))];
}

/** An open picker: a question neither answered nor declined, or a plan with no outcome. */
export function isOpenPicker(entry: ChatEntry): boolean {
  if (entry.kind === "question") return entry.answer === null && entry.declined !== true;
  if (entry.kind === "plan") return entry.outcome === null;
  return false;
}

/**
 * The id of the one picker the chat may answer: the newest question or plan,
 * if it is still open. An older open picker is stale (the mirror refuses it
 * too), and so is everything once the newest picker has been answered.
 */
export function answerablePickerId(entries: readonly ChatEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind !== "question" && entry.kind !== "plan") continue;
    return isOpenPicker(entry) ? entry.id : null;
  }
  return null;
}

type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;

/** A run of back-to-back tool calls, drawn as one collapsible line. */
export type ToolGroup = {
  kind: "tool-group";
  /** The first call's id, so the group keeps its key (and open state) as calls arrive. */
  id: string;
  tools: ToolEntry[];
};

/** What a task card shows: its entry's status, or "unknown" when it can't be trusted. */
export type TaskDisplayStatus = ChatTaskEntry["status"] | "unknown";

/** A task as the chat draws it: its entry, and the status it shows. */
export type TaskItem = ChatTaskEntry & { display: TaskDisplayStatus };

export type ChatItem = Exclude<ChatEntry, { kind: "tool" | "task" }> | ToolGroup | TaskItem;

/**
 * The chat's items: each run of consecutive tool entries folded into one
 * group (anything else ends a run, a landed edit's card too), and each task with the status it shows
 * while the pane's agent is `agentStatus` (`staleTaskIds`).
 */
export function groupEntries(
  entries: readonly ChatEntry[],
  agentStatus: AgentStatus | null = null,
): ChatItem[] {
  const stale = staleTaskIds(entries, agentStatus);
  const items: ChatItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "task") {
      items.push({ ...entry, display: stale.has(entry.id) ? "unknown" : entry.status });
      continue;
    }
    if (entry.kind !== "tool") {
      items.push(entry);
      continue;
    }
    const last = items[items.length - 1];
    if (last?.kind === "tool-group") last.tools.push(entry);
    else items.push({ kind: "tool-group", id: entry.id, tools: [entry] });
  }
  return items;
}

/**
 * Whether two items draw the same: the same entries, field for field. A tool
 * group's `tools` and a task item are rebuilt on every `groupEntries`, so
 * identity alone would redraw the whole chat on every push.
 */
export function sameItem(a: ChatItem, b: ChatItem): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof ChatItem)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    if (!(key in b)) return false;
    const x: unknown = a[key];
    const y: unknown = b[key];
    if (Array.isArray(x) && Array.isArray(y)) {
      return x.length === y.length && x.every((v, i) => v === y[i]);
    }
    return x === y;
  });
}

type Phrase = {
  /** Tool names this phrase covers. */
  names: readonly string[];
  verb: string;
  /** Singular and plural nouns; none means the verb stands alone ("searched the web"). */
  noun?: readonly [string, string];
};

const PHRASES: readonly Phrase[] = [
  // Codex's calls too: every shell tool it has is "shell" (`adapters/codex.ts`).
  { names: ["Bash", "shell"], verb: "ran", noun: ["command", "commands"] },
  { names: ["Read"], verb: "read", noun: ["file", "files"] },
  // Only edits still running or that failed: a landed one is its own card.
  { names: ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"], verb: "edited", noun: ["file", "files"] },
  { names: ["Grep", "Glob"], verb: "searched", noun: ["the code", "the code"] },
  { names: ["WebSearch", "WebFetch", "web_search"], verb: "searched the web" },
  { names: ["Agent", "Task"], verb: "ran", noun: ["agent", "agents"] },
  { names: ["TodoWrite"], verb: "updated the todo list" },
  { names: ["update_plan"], verb: "updated the plan" },
];
const OTHER: Phrase = { names: [], verb: "used", noun: ["tool", "tools"] };

export type SummaryPart = { text: string; failed: number };

/**
 * A run of tool calls as a sentence, one part per kind of call in the order
 * each first appears: "Ran 2 commands", "read a file". Failures are counted
 * per part so the view can mark them.
 */
export function summarizeTools(
  tools: readonly { name: string; status?: ToolEntry["status"] }[],
): SummaryPart[] {
  const counts = new Map<Phrase, { n: number; failed: number }>();
  for (const tool of tools) {
    const phrase = PHRASES.find((p) => p.names.includes(tool.name)) ?? OTHER;
    const count = counts.get(phrase) ?? { n: 0, failed: 0 };
    count.n++;
    if (tool.status === "error") count.failed++;
    counts.set(phrase, count);
  }
  return [...counts].map(([phrase, { n, failed }], i) => {
    const text = phraseText(phrase, n);
    return { text: i === 0 ? text[0].toUpperCase() + text.slice(1) : text, failed };
  });
}

function phraseText(phrase: Phrase, n: number): string {
  if (!phrase.noun) return phrase.verb;
  const [one, many] = phrase.noun;
  if (one === many) return `${phrase.verb} ${one}`;
  if (n > 1) return `${phrase.verb} ${n} ${many}`;
  return `${phrase.verb} ${/^[aeiou]/.test(one) ? "an" : "a"} ${one}`;
}

/**
 * The ids of running tasks the card should call "unknown". A task
 * that never gets a notification (its session was killed) stays "running" in
 * the transcript for good, so while the pane's agent is idle or has answered,
 * a running task from before the latest user turn is shown as unknown. Display
 * only: the entry is untouched.
 *
 * Agent tasks only. The status holds a Stop while subagents run, so
 * idle or responded means none is; a background shell command has no hooks
 * and can outlive the turn, so the status says nothing about it.
 */
export function staleTaskIds(
  entries: readonly ChatEntry[],
  agentStatus: AgentStatus | null,
): Set<string> {
  const stale = new Set<string>();
  if (agentStatus !== "idle" && agentStatus !== "responded") return stale;
  let lastUser = -1;
  entries.forEach((e, i) => {
    if (e.kind === "user") lastUser = i;
  });
  entries.forEach((e, i) => {
    if (
      e.kind === "task" &&
      e.taskKind === "agent" &&
      e.status === "running" &&
      i < lastUser
    ) {
      stale.add(e.id);
    }
  });
  return stale;
}

/** How many tasks show as running (the stale ones show as unknown). */
export function runningTaskCount(items: readonly ChatItem[]): number {
  return items.filter((i) => i.kind === "task" && i.display === "running").length;
}

/** The dot's `data-status`: the shared dot styles know pending, ok and error. */
export const TASK_DOT: Record<TaskDisplayStatus, string> = {
  running: "pending",
  ok: "ok",
  error: "error",
  killed: "error",
  unknown: "unknown",
};

export const TASK_LABEL: Record<TaskDisplayStatus, string> = {
  running: "running",
  ok: "done",
  error: "failed",
  killed: "stopped",
  unknown: "status unknown",
};

/** Seconds as `42s`, `3m 05s`, `1h 02m`. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The first line of a result, for the one-line preview. */
export function resultPreview(result: string | undefined): string | null {
  const line = result?.split("\n").find((l) => l.trim() !== "");
  return line ? line.trim() : null;
}
