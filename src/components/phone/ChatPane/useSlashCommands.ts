import { useRef, useState } from "react";
import {
  opensMenu as commandOpensMenu,
  type ChatCommand,
} from "../../../../electron/chat-mirror/builtin-commands";
import { applyCommand, findSlashQuery, matchCommands } from "./slash-commands";

/** A cached list older than this is refetched the next time the menu opens. */
const STALE_MS = 30_000;

type CommandCache = { commands: ChatCommand[]; skillsKnown: boolean; at: number };

/**
 * The composer's `/` menu state (ADR-217 D5).
 *
 * The command list is fetched lazily with `chat.getCommands` the first time a
 * `/` query appears, kept here, and refetched when the menu opens on a list
 * older than 30s. A failed or `ok: false` fetch leaves the menu closed; typing
 * is never blocked on it.
 *
 * There is no effect: the composer calls `sync(text, caret)` from its change
 * and select handlers, which is where a fetch is started.
 */
export function useSlashCommands(paneId: string, text: string, caret: number) {
  const [cache, setCache] = useState<CommandCache | null>(null);
  const [selection, setSelection] = useState<{ query: string; index: number }>({
    query: "",
    index: 0,
  });
  // Esc closes the menu until the text changes.
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  // Whether the last `sync` saw a query, so a fetch happens on each open.
  const hadQueryRef = useRef(false);

  const slash = findSlashQuery(text, caret);
  const items = slash && cache ? matchCommands(cache.commands, slash.query) : [];
  const open = slash !== null && dismissedText !== text && items.length > 0;
  const rawIndex = slash && selection.query === slash.query ? selection.index : 0;
  const selectedIndex = items.length ? Math.min(rawIndex, items.length - 1) : 0;

  const fetchCommands = () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    window.electronAPI.chat.getCommands(paneId).then(
      (result) => {
        inFlightRef.current = false;
        if (result.ok) {
          setCache({ commands: result.commands, skillsKnown: result.skillsKnown, at: Date.now() });
        }
      },
      () => {
        inFlightRef.current = false;
      },
    );
  };

  /** Call with the field's text and caret after every change or selection. */
  const sync = (nextText: string, nextCaret: number) => {
    const hasQuery = findSlashQuery(nextText, nextCaret) !== null;
    const opening = hasQuery && !hadQueryRef.current;
    hadQueryRef.current = hasQuery;
    if (!opening) return;
    if (!cache || Date.now() - cache.at > STALE_MS) fetchCommands();
  };

  const move = (delta: number) => {
    if (!open || !slash) return;
    const n = items.length;
    setSelection({ query: slash.query, index: (((selectedIndex + delta) % n) + n) % n });
  };

  /** What picking row `index` does, or null if closed: fill in `/name `, or
   *  for a command with `choices` hand it over for the choice sheet (ADR-218
   *  D2), leaving the text alone. */
  const pick = (
    index: number,
  ): ({ kind: "text"; text: string; caret: number } | { kind: "choices"; command: ChatCommand }) | null => {
    const item = items[index];
    if (!open || !item) return null;
    if (item.choices?.length) return { kind: "choices", command: item };
    return { kind: "text", ...applyCommand(text, caret, item.name) };
  };

  const close = () => setDismissedText(text);

  /** Whether sending `/name args` opens a TUI menu: the fetched entry's flags,
   *  else the built-in's (a skill of the same name replaces a built-in). */
  const opensMenu = (name: string, args: string): boolean =>
    commandOpensMenu(cache?.commands.find((c) => c.name === name), name, args);

  return {
    open,
    items,
    selectedIndex,
    skillsKnown: cache?.skillsKnown ?? true,
    sync,
    move,
    pick,
    close,
    opensMenu,
  };
}
