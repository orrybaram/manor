import { create } from "zustand";
import {
  KeyCombo,
  DEFAULT_KEYBINDINGS,
  resolveBindings,
  serializeCombo,
} from "../lib/keybindings";
import { isWebApp } from "../lib/platform";

/**
 * `keybindings.set`/`reset`/`resetAll` stay off the ADR-178 bridge table —
 * `KeybindingsPage` disables its controls on web, so these never fire from a
 * browser. `persist` below still swallows a rejection rather than crash the
 * store if that ever changes.
 */

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

/**
 * The OS picks ⌘ versus Ctrl; being a browser tab only removes the chords the
 * browser keeps for itself (ADR-181 D7). Two separate facts, passed separately
 * — see `platformDefaults`.
 */
const resolve = (overrides: Record<string, string>) =>
  resolveBindings(overrides, navigator.platform, { inBrowser: isWebApp() });

/** Fires and forgets a bridge write — see the store-level comment above. */
function persist(promise: Promise<void> | undefined): void {
  promise?.catch(() => {});
}

export const useKeybindingsStore = create<KeybindingsState>((set) => {
  const defaultBindings = resolve({}).bindings;

  window.electronAPI?.keybindings
    .getAll()
    .then((overrides) => {
      const { bindings, overriddenIds } = resolve(overrides);
      set({ bindings, overriddenIds, loaded: true });
    })
    .catch(() => {});

  window.electronAPI?.keybindings.onChange((overrides) => {
    const { bindings, overriddenIds } = resolve(overrides);
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
      persist(
        window.electronAPI?.keybindings.set(commandId, serializeCombo(combo)),
      );
    },

    reset: (commandId) => {
      const platformDefault = resolve({}).bindings[commandId];
      set((s) => {
        const overriddenIds = new Set(s.overriddenIds);
        overriddenIds.delete(commandId);
        return {
          bindings: { ...s.bindings, [commandId]: platformDefault },
          overriddenIds,
        };
      });
      persist(window.electronAPI?.keybindings.reset(commandId));
    },

    resetAll: () => {
      const defaults = resolve({}).bindings;
      set({ bindings: defaults, overriddenIds: new Set<string>() });
      persist(window.electronAPI?.keybindings.resetAll());
    },
  };
});

/** Selector hook — returns the current KeyCombo for the given command ID */
export function useKeybinding(commandId: string): KeyCombo {
  return useKeybindingsStore((s) => s.bindings[commandId]);
}

export type { KeyCombo };
export { DEFAULT_KEYBINDINGS };
