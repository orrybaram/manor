import { opensMenu, type ChatCommand } from "../../../../electron/chat-mirror/builtin-commands";

/**
 * Pure helpers for the phone composer's `/` menu.
 *
 * A command is only recognised at the very start of a message, as in Claude
 * Code: the text starts with `/` and the caret sits inside that first word.
 */

/**
 * The `/` query the caret is in, or null.
 *
 * Non-null only when `text` starts with `/`, the caret is past the slash and
 * no further than the end of the first whitespace-free run. The query is the
 * text between the slash and the caret.
 */
export function findSlashQuery(text: string, caret: number): { query: string } | null {
  if (!text.startsWith("/")) return null;
  if (caret <= 0 || caret > text.length) return null;
  const firstRunEnd = text.search(/\s/);
  const end = firstRunEnd === -1 ? text.length : firstRunEnd;
  if (caret > end) return null;
  return { query: text.slice(1, caret) };
}

function byName(a: ChatCommand, b: ChatCommand): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 0 = best. Returns -1 for no match. */
function rank(command: ChatCommand, query: string): number {
  const name = command.name.toLowerCase();
  if (name.startsWith(query)) return 0;
  const colon = name.lastIndexOf(":");
  if (colon !== -1 && name.slice(colon + 1).startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (command.description.toLowerCase().includes(query)) return 3;
  return -1;
}

/**
 * Commands matching `query`, best first, at most `limit`.
 *
 * Case-insensitive: name prefix, then prefix of the part after the last `:`
 * (`plugin:skill`), then name substring, then description substring. Ties
 * stay alphabetical. An empty query lists the first `limit` alphabetically.
 */
export function matchCommands(
  commands: readonly ChatCommand[],
  query: string,
  limit = 8,
): ChatCommand[] {
  const sorted = [...commands].sort(byName);
  const q = query.toLowerCase();
  if (!q) return sorted.slice(0, limit);

  const buckets: ChatCommand[][] = [[], [], [], []];
  for (const command of sorted) {
    const r = rank(command, q);
    if (r !== -1) buckets[r].push(command);
  }
  return buckets.flat().slice(0, limit);
}

/**
 * Replace the `/query` before the caret with `/name ` and put the caret after
 * the space. Anything after the first word is kept.
 */
export function applyCommand(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const firstRunEnd = text.search(/\s/);
  const end = firstRunEnd === -1 ? text.length : Math.max(firstRunEnd, caret);
  let rest = text.slice(end);
  // Don't double up the space when the word was already followed by one.
  if (/^\s/.test(rest)) rest = rest.replace(/^[ \t]/, "");
  const head = `/${name} `;
  return { text: head + rest, caret: head.length };
}

/** The command name and the trimmed text after it, when `text` starts with
 *  `/name` + whitespace or the end. */
export function splitCommand(text: string): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(text);
  return match ? { name: match[1], args: (match[2] ?? "").trim() } : null;
}

/** Claude Code's `/clear` and its aliases: each starts a new session. */
const CLEAR_COMMANDS = new Set(["clear", "reset", "new"]);

/**
 * What a sent command does to the chat: "menu" hands the pane to the terminal
 * "clear" leaves the conversation behind for a fresh one, null
 * is nothing. `lookup` finds the entry for a name (fetched list, then built-ins).
 */
export function commandEffect(
  command: { name: string; args: string } | null,
  lookup: (name: string) => ChatCommand | undefined,
): "menu" | "clear" | null {
  if (!command) return null;
  if (opensMenu(lookup(command.name), command.args)) return "menu";
  if (CLEAR_COMMANDS.has(command.name)) return "clear";
  return null;
}

/** The DOM id of row `index` in the menu, for `aria-activedescendant`. */
export function slashOptionId(listboxId: string, index: number): string {
  return `${listboxId}-option-${index}`;
}
