import { create } from "zustand";
import {
  KeyCombo,
  DEFAULT_KEYBINDINGS,
  platformDefaults,
  serializeCombo,
  deserializeCombo,
} from "../lib/keybindings";

interface KeybindingsState {
  /** Merged map: commandId → KeyCombo (defaults + overrides applied) */
  bindings: Record<string, KeyCombo>;
  /** Set of command IDs that have been overridden by the user */
  overriddenIds: Set<string>;
  loaded: boolean;

  set: (commandId: string, combo: KeyCombo) => void;
  reset: (commandId: string) => void;
  resetAll: () => void;
}

/** Build a Record<string, KeyCombo> from platform defaults */
function buildDefaultBindings(): Record<string, KeyCombo> {
  const defaults = platformDefaults();
  const result: Record<string, KeyCombo> = {};
  for (const def of defaults) {
    result[def.id] = def.defaultCombo;
  }
  return result;
}

/** Merge serialized overrides into a defaults map, returning new merged map and overridden IDs */
function mergeOverrides(
  defaults: Record<string, KeyCombo>,
  overrides: Record<string, string>,
): { bindings: Record<string, KeyCombo>; overriddenIds: Set<string> } {
  const bindings = { ...defaults };
  const overriddenIds = new Set<string>();
  for (const [commandId, serialized] of Object.entries(overrides)) {
    bindings[commandId] = deserializeCombo(serialized);
    overriddenIds.add(commandId);
  }
  return { bindings, overriddenIds };
}

export const useKeybindingsStore = create<KeybindingsState>((set) => {
  const defaultBindings = buildDefaultBindings();

  // Load initial overrides on store creation
  window.electronAPI?.keybindings.getAll().then((overrides) => {
    const { bindings, overriddenIds } = mergeOverrides(defaultBindings, overrides);
    set({ bindings, overriddenIds, loaded: true });
  }).catch(() => {});

  // Subscribe to live keybinding updates
  window.electronAPI?.keybindings.onChange((overrides) => {
    const { bindings, overriddenIds } = mergeOverrides(defaultBindings, overrides);
    set({ bindings, overriddenIds });
  });

  return {
    bindings: defaultBindings,
    overriddenIds: new Set<string>(),
    loaded: false,

    set: (commandId, combo) => {
      // Optimistically update local state
      set((s) => ({
        bindings: { ...s.bindings, [commandId]: combo },
        overriddenIds: new Set([...s.overriddenIds, commandId]),
      }));
      // Persist to main process
      window.electronAPI?.keybindings.set(commandId, serializeCombo(combo));
    },

    reset: (commandId) => {
      const platformDefault = buildDefaultBindings()[commandId];
      set((s) => {
        const overriddenIds = new Set(s.overriddenIds);
        overriddenIds.delete(commandId);
        return {
          bindings: { ...s.bindings, [commandId]: platformDefault },
          overriddenIds,
        };
      });
      window.electronAPI?.keybindings.reset(commandId);
    },

    resetAll: () => {
      const defaults = buildDefaultBindings();
      set({ bindings: defaults, overriddenIds: new Set<string>() });
      window.electronAPI?.keybindings.resetAll();
    },
  };
});

/** Selector hook — returns the current KeyCombo for the given command ID */
export function useKeybinding(commandId: string): KeyCombo {
  return useKeybindingsStore((s) => s.bindings[commandId]);
}

// Re-export for convenience
export type { KeyCombo };
export { DEFAULT_KEYBINDINGS };
