import { create } from "zustand";
import {
  KeyCombo,
  DEFAULT_KEYBINDINGS,
  resolveBindings,
  serializeCombo,
} from "../lib/keybindings";
import { handleBridgeUnavailable } from "../lib/bridge-unavailable-toast";

/**
 * `keybindings.set`/`reset`/`resetAll` stay off the ADR-178 bridge table —
 * ticket 6 made the keybindings page read-only on web — so every call from
 * here is refused with the same `BridgeUnavailableError` on a browser. One
 * toast per session beats a silent no-op or an unhandled rejection per edit.
 */
const KEYBINDINGS_UNAVAILABLE_MESSAGE =
  "Keybinding changes aren't saved from the browser yet";

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
      window.electronAPI?.keybindings
        .set(commandId, serializeCombo(combo))
        ?.catch(
          handleBridgeUnavailable(
            "keybindings-set-unavailable",
            KEYBINDINGS_UNAVAILABLE_MESSAGE,
          ),
        );
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
      window.electronAPI?.keybindings
        .reset(commandId)
        ?.catch(
          handleBridgeUnavailable(
            "keybindings-set-unavailable",
            KEYBINDINGS_UNAVAILABLE_MESSAGE,
          ),
        );
    },

    resetAll: () => {
      const defaults = resolveBindings({}, navigator.platform).bindings;
      set({ bindings: defaults, overriddenIds: new Set<string>() });
      window.electronAPI?.keybindings
        .resetAll()
        ?.catch(
          handleBridgeUnavailable(
            "keybindings-set-unavailable",
            KEYBINDINGS_UNAVAILABLE_MESSAGE,
          ),
        );
    },
  };
});

/** Selector hook — returns the current KeyCombo for the given command ID */
export function useKeybinding(commandId: string): KeyCombo {
  return useKeybindingsStore((s) => s.bindings[commandId]);
}

export type { KeyCombo };
export { DEFAULT_KEYBINDINGS };
