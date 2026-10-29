import { formatCombo, type KeyCombo } from "../../../lib/keybindings";

/**
 * What a key does anywhere in a focused file pane, as in VS Code: ⌘B shows or
 * hides the drawer, ⌘⇧E goes to Files and ⌘⇧G to Changed by agents. They
 * beat the app's own ⌘⇧E (focus the sidebar) and ⌘⇧G (open the diff) only
 * while the pane has focus.
 */
export type FilePaneKey = "toggle-drawer" | "files" | "changes";

const KEYS: Record<FilePaneKey, { key: string; shift: boolean }> = {
  "toggle-drawer": { key: "b", shift: false },
  files: { key: "e", shift: true },
  changes: { key: "g", shift: true },
};

/** ⌘ on macOS, Ctrl elsewhere. */
function combo(action: FilePaneKey, mac: boolean): KeyCombo {
  const { key, shift } = KEYS[action];
  return { key, meta: mac, ctrl: !mac, shift, alt: false };
}

export function filePaneKey(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean,
): FilePaneKey | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key.toLowerCase();
  for (const action of Object.keys(KEYS) as FilePaneKey[]) {
    if (KEYS[action].key === key && KEYS[action].shift === e.shiftKey) return action;
  }
  return null;
}

/** "⌘⇧E" or "Ctrl+Shift+E", for a tooltip. */
export function filePaneKeyLabel(action: FilePaneKey, mac: boolean): string {
  return formatCombo(combo(action, mac), mac ? "mac" : "other");
}
