import { create } from "zustand";
import {
  KeyCombo,
  DEFAULT_KEYBINDINGS,
  resolveBindings,
  serializeCombo,
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

export const useKeybindingsStore = create<KeybindingsState>((set) => {
  const defaultBindings = resolveBindings({}, navigator.platform).bindings;

  window.electronAPI?.keybindings
    .getAll()
    .then((overrides) => {
      const { bindings, overriddenIds } = resolveBindings(
        overrides,
        navigator.platform,
      );
      set({ bindings, overriddenIds, loaded: true });
    })
    .catch(() => {});

  window.electronAPI?.keybindings.onChange((overrides) => {
    const { bindings, overriddenIds } = resolveBindings(
      overrides,
      navigator.platform,
    );
    set({ bindings, overriddenIds });
  });

  return {
    bindings: defaultBindings,
    overriddenIds: new Set<string>(),
    loaded: false,

    set: (commandId, combo) => {
      set((s) => ({
        bindings: { ...s.bindings, [commandId]: combo },
        overriddenIds: new Set([...s.overriddenIds, commandId]),
      }));
      window.electronAPI?.keybindings.set(commandId, serializeCombo(combo));
    },

    reset: (commandId) => {
      const platformDefault = resolveBindings({}, navigator.platform)
        .bindings[commandId];
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
      const defaults = resolveBindings({}, navigator.platform).bindings;
      set({ bindings: defaults, overriddenIds: new Set<string>() });
      window.electronAPI?.keybindings.resetAll();
    },
  };
});

/** Selector hook — returns the current KeyCombo for the given command ID */
export function useKeybinding(commandId: string): KeyCombo {
  return useKeybindingsStore((s) => s.bindings[commandId]);
}

export type { KeyCombo };
export { DEFAULT_KEYBINDINGS };
