import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CommandUsage {
  count: number;
  lastUsed: number; // Date.now()
}

export type CommandUsageMap = Record<string, CommandUsage>;

interface CommandUsageState {
  usage: CommandUsageMap;
  record: (commandId: string) => void;
}

/** Upper bound on tracked commands so the persisted blob stays small. */
const MAX_TRACKED = 100;

/** Command ids ordered most-used first; ties broken by most recently used. */
export function rankCommandIds(usage: CommandUsageMap): string[] {
  return Object.entries(usage)
    .sort(([, a], [, b]) => b.count - a.count || b.lastUsed - a.lastUsed)
    .map(([id]) => id);
}

export function recordUsage(
  usage: CommandUsageMap,
  commandId: string,
  now: number = Date.now(),
): CommandUsageMap {
  const prev = usage[commandId];
  const next: CommandUsageMap = {
    ...usage,
    [commandId]: { count: (prev?.count ?? 0) + 1, lastUsed: now },
  };
  const ids = Object.keys(next);
  if (ids.length <= MAX_TRACKED) return next;
  // Evict the entries that haven't been used for the longest, so a command
  // used for the first time can still enter a full map.
  ids.sort((a, b) => next[a].lastUsed - next[b].lastUsed);
  for (const id of ids.slice(0, ids.length - MAX_TRACKED)) delete next[id];
  return next;
}

export const useCommandUsageStore = create<CommandUsageState>()(
  persist(
    (set) => ({
      usage: {},
      record: (commandId) =>
        set((state) => ({ usage: recordUsage(state.usage, commandId) })),
    }),
    { name: "command-usage" },
  ),
);
