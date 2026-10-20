import { useId, useRef, useState } from "react";
import {
  findBuiltin,
  type ChatCommand,
} from "../../../../electron/chat-mirror/builtin-commands";
import { onBridgeResync } from "../../../bridge/resync";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { applyCommand, findSlashQuery, matchCommands } from "./slash-commands";

/** A cached list older than this is refetched the next time the menu opens. */
const STALE_MS = 30_000;

type CommandCache = { commands: ChatCommand[]; skillsKnown: boolean; at: number };

/** One option in a listbox level. `activate` is what tapping it or Enter on
 *  it does. */
export type ListboxRow = {
  key: string;
  label: string;
  description?: string;
  testId: string;
  activate: () => void;
  /** Command rows: the name, as `data-command`, and a tag beside it. */
  command?: string;
  tag?: string;
};

/**
 * The listbox the composer drives from its textarea: the `/` menu, or the
 * choice sheet that one of its commands opens. Only one is
 * active at a time.
 */
export type ListboxLevel = {
  listboxId: string;
  rows: ListboxRow[];
  selectedIndex: number;
  move: (delta: number) => void;
  activateSelected: () => void;
  /** Esc or a tap outside: close, and keep the `/` menu shut until the text
   *  changes. */
  dismiss: () => void;
} & ({ kind: "commands" } | { kind: "choices"; command: ChatCommand });

/** What the composer does for a row: put text in the field, or send it. */
type SlashActions = {
  fill: (text: string, caret: number) => void;
  send: (text: string) => void;
};

function wrap(index: number, n: number): number {
  return ((index % n) + n) % n;
}

/**
 * The composer's `/` menu state, and the choice sheet a command
 * with `choices` opens in its place. `level` is whichever is
 * showing, as one listbox; picking a row calls back into `actions`.
 *
 * The command list is fetched lazily with `chat.getCommands` the first time a
 * `/` query appears, kept here, and refetched when the menu opens on a list
 * older than 30s. A failed or `ok: false` fetch leaves the menu closed; typing
 * is never blocked on it.
 *
 * The composer calls `sync(text, caret)` from its change and select handlers,
 * which is where a fetch is started. The one effect is the bridge resync:
 * a list already fetched is marked stale, since skills may
 * have changed while the socket was down, so the next open refetches it.
 * One never fetched stays lazy.
 */
export function useSlashCommands(
  paneId: string,
  text: string,
  caret: number,
  actions: SlashActions,
) {
  const listboxId = `${useId()}-slash-listbox`;
  const [cache, setCache] = useState<CommandCache | null>(null);
  const [selection, setSelection] = useState<{ query: string; index: number }>({
    query: "",
    index: 0,
  });
  // Esc closes the menu until the text changes.
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  // The command whose choice sheet is open, and its selected row.
  const [choiceFor, setChoiceFor] = useState<ChatCommand | null>(null);
  const [choiceIndex, setChoiceIndex] = useState(0);
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

  useMountEffect(() =>
    onBridgeResync(() => setCache((c) => c && { ...c, at: 0 })),
  );

  /** Call with the field's text and caret after every change or selection. */
  const sync = (nextText: string, nextCaret: number) => {
    // Any edit lifts an Esc, even one that later retypes the same text.
    if (dismissedText !== null && nextText !== dismissedText) setDismissedText(null);
    // Typing past the choice sheet drops it.
    if (nextText !== text) setChoiceFor(null);
    const hasQuery = findSlashQuery(nextText, nextCaret) !== null;
    const opening = hasQuery && !hadQueryRef.current;
    hadQueryRef.current = hasQuery;
    if (!opening) return;
    if (!cache || Date.now() - cache.at > STALE_MS) fetchCommands();
  };

  const close = () => setDismissedText(text);

  const commandRow = (item: ChatCommand): ListboxRow => ({
    key: item.name,
    label: `/${item.name}`,
    description: item.description || undefined,
    testId: "slash-command-item",
    command: item.name,
    tag: item.menu && !item.choices ? "Opens in terminal" : undefined,
    activate: () => {
      // A command with fixed arguments opens its choice sheet, leaving the
      // text alone; any other fills in `/name `.
      if (item.choices?.length) {
        setChoiceFor(item);
        setChoiceIndex(0);
        return;
      }
      const next = applyCommand(text, caret, item.name);
      actions.fill(next.text, next.caret);
    },
  });

  const choiceRows = (command: ChatCommand): ListboxRow[] => {
    const head = `/${command.name}`;
    const closeThen = (act: () => void) => () => {
      setChoiceFor(null);
      act();
    };
    return [
      ...(command.choices ?? []).map((choice) => ({
        key: choice.value,
        label: choice.label,
        description: choice.description,
        testId: `command-choice-${choice.value}`,
        activate: closeThen(() => actions.send(`${head} ${choice.value}`)),
      })),
      {
        key: "other",
        label: "Other…",
        testId: "command-choice-other",
        activate: closeThen(() => actions.fill(`${head} `, head.length + 1)),
      },
      {
        key: "terminal",
        label: "Open menu in terminal",
        testId: "command-choice-terminal",
        activate: closeThen(() => actions.send(head)),
      },
    ];
  };

  const level = ((): ListboxLevel | null => {
    if (choiceFor) {
      const rows = choiceRows(choiceFor);
      const selected = Math.min(choiceIndex, rows.length - 1);
      return {
        kind: "choices",
        command: choiceFor,
        listboxId: `${listboxId}-choices`,
        rows,
        selectedIndex: selected,
        move: (delta) => setChoiceIndex(wrap(selected + delta, rows.length)),
        activateSelected: () => rows[selected].activate(),
        dismiss: () => {
          setChoiceFor(null);
          close();
        },
      };
    }
    if (!open || !slash) return null;
    const rows = items.map(commandRow);
    return {
      kind: "commands",
      listboxId,
      rows,
      selectedIndex,
      move: (delta) =>
        setSelection({ query: slash.query, index: wrap(selectedIndex + delta, rows.length) }),
      activateSelected: () => rows[selectedIndex].activate(),
      dismiss: close,
    };
  })();

  /** The entry for `/name`: the fetched one, else the built-in (a skill of the
   *  same name replaces a built-in). */
  const lookup = (name: string): ChatCommand | undefined =>
    cache?.commands.find((c) => c.name === name) ?? findBuiltin(name);

  return {
    level,
    skillsKnown: cache?.skillsKnown ?? true,
    sync,
    lookup,
  };
}
