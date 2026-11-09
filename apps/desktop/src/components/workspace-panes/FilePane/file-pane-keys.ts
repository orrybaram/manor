import { formatCombo, type KeyCombo } from "../../../lib/keybindings";

/**
 * What a key does anywhere in a focused file pane, as in VS Code: ⌘B shows or
 * hides the drawer, ⌘⇧E goes to Files and ⌘⇧G to Source Control. They beat
 * the app's own ⌘⇧E (focus the sidebar) and ⌘⇧G (Open Source Control, which
 * would come to this pane anyway) only while the pane has focus.
 */
export type FilePaneKey = "toggle-drawer" | "files" | "scm";

/**
 * What a key does while the open file has the keyboard, which only that file's
 * view can answer: it holds what is unsaved and whether it shows rendered.
 * ⌘⇧V toggles the preview as in VS Code.
 */
export type OpenFileKey = "save" | "find" | "toggle-preview";

type KeySpec = { key: string; shift: boolean };

const KEYS: Record<FilePaneKey, KeySpec> = {
  "toggle-drawer": { key: "b", shift: false },
  files: { key: "e", shift: true },
  scm: { key: "g", shift: true },
};

const OPEN_FILE_KEYS: Record<OpenFileKey, KeySpec> = {
  save: { key: "s", shift: false },
  find: { key: "f", shift: false },
  "toggle-preview": { key: "v", shift: true },
};

type KeyEvent = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** The action `e` presses in `table`: ⌘ on macOS, Ctrl elsewhere. */
function keyIn<A extends string>(table: Record<A, KeySpec>, e: KeyEvent, mac: boolean): A | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  const key = e.key.toLowerCase();
  for (const action of Object.keys(table) as A[]) {
    if (table[action].key === key && table[action].shift === e.shiftKey) return action;
  }
  return null;
}

/** "⌘⇧E" or "Ctrl+Shift+E", for a tooltip. */
function keyLabel({ key, shift }: KeySpec, mac: boolean): string {
  const combo: KeyCombo = { key, meta: mac, ctrl: !mac, shift, alt: false };
  return formatCombo(combo, mac ? "mac" : "other");
}

export function filePaneKey(e: KeyEvent, mac: boolean): FilePaneKey | null {
  return keyIn(KEYS, e, mac);
}

export function filePaneKeyLabel(action: FilePaneKey, mac: boolean): string {
  return keyLabel(KEYS[action], mac);
}

export function openFileKey(e: KeyEvent, mac: boolean): OpenFileKey | null {
  return keyIn(OPEN_FILE_KEYS, e, mac);
}

export function openFileKeyLabel(action: OpenFileKey, mac: boolean): string {
  return keyLabel(OPEN_FILE_KEYS[action], mac);
}
