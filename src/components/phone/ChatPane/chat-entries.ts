/**
 * The phone chat view's entry list, kept as pure functions so the view's
 * ordering and "which picker can be answered" rules are testable without a
 * DOM (ADR-215 D5, D7).
 */

import type { ChatEntry } from "../../../electron.d";
import type { MenuHandoff } from "./usePaneChatView";

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

/** An open picker: a question with no answer yet, or a plan with no outcome. */
export function isOpenPicker(entry: ChatEntry): boolean {
  if (entry.kind === "question") return entry.answer === null;
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

/** Clock slack between this device's send and the transcript's timestamp. */
const HANDOFF_SLACK_MS = 2_000;

/**
 * Whether `entry` means the TUI menu `handoff` waits on has closed (ADR-218
 * D3): the handoff's command, logged at or after it was sent. A menu
 * command's transcript line is written when the menu completes, not when it
 * opens. A `ts` that doesn't parse never ends it.
 */
export function endsMenuHandoff(handoff: MenuHandoff, entry: ChatEntry): boolean {
  if (entry.kind !== "command" || entry.name !== handoff.name) return false;
  const ts = Date.parse(entry.ts);
  return !Number.isNaN(ts) && ts >= handoff.startedAt - HANDOFF_SLACK_MS;
}

type ToolEntry = Extract<ChatEntry, { kind: "tool" }>;

/** A run of back-to-back tool calls, drawn as one collapsible line. */
export type ToolGroup = {
  kind: "tool-group";
  /** The first call's id, so the group keeps its key (and open state) as calls arrive. */
  id: string;
  tools: ToolEntry[];
};

export type ChatItem = Exclude<ChatEntry, { kind: "tool" }> | ToolGroup;

/** Fold each run of consecutive tool entries into one group. Anything else ends a run. */
export function groupEntries(entries: readonly ChatEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const entry of entries) {
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

type Phrase = {
  /** Tool names this phrase covers. */
  names: readonly string[];
  verb: string;
  /** Singular and plural nouns; none means the verb stands alone ("searched the web"). */
  noun?: readonly [string, string];
};

const PHRASES: readonly Phrase[] = [
  { names: ["Bash"], verb: "ran", noun: ["command", "commands"] },
  { names: ["Read"], verb: "read", noun: ["file", "files"] },
  { names: ["Edit", "MultiEdit", "Write", "NotebookEdit"], verb: "edited", noun: ["file", "files"] },
  { names: ["Grep", "Glob"], verb: "searched", noun: ["the code", "the code"] },
  { names: ["WebSearch", "WebFetch"], verb: "searched the web" },
  { names: ["Agent", "Task"], verb: "ran", noun: ["agent", "agents"] },
  { names: ["TodoWrite"], verb: "updated the todo list" },
];
const OTHER: Phrase = { names: [], verb: "used", noun: ["tool", "tools"] };

export type SummaryPart = { text: string; failed: number };

/**
 * A run of tool calls as a sentence, one part per kind of call in the order
 * each first appears: "Ran 2 commands", "read a file". Failures are counted
 * per part so the view can mark them.
 */
export function summarizeTools(tools: readonly ToolEntry[]): SummaryPart[] {
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
