import { usePreferencesStore } from "../store/preferences-store";
import { useAppStore } from "../store/app-store";

const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "neovim",
  "emacs",
  "nano",
  "micro",
  "helix",
  "hx",
  "joe",
  "jed",
  "kakoune",
  "kak",
]);

export function isTerminalEditor(cmd: string): boolean {
  const bin = cmd.split(/\s+/)[0];
  const base = bin.split("/").pop()!;
  return TERMINAL_EDITORS.has(base);
}

export function openInEditor(dirPath: string): void {
  const { preferences } = usePreferencesStore.getState();
  const editor = preferences.defaultEditor;

  if (editor && preferences.editorIsTerminal) {
    useAppStore.getState().addTerminalTab(`${editor} ${dirPath}`);
    return;
  }

  window.electronAPI.shell.openInEditor(dirPath);
}
