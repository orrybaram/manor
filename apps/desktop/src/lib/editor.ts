import { usePreferencesStore } from "../store/preferences-store";
import { useAppStore } from "../store/app-store";
import { toast } from "../toast";
import { hasControlChars, shellQuote } from "./terminal-file-drop";

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
    // The path is typed into a shell, and file names come from the repo.
    if (hasControlChars(dirPath)) {
      toast.error("This file's name has characters Manor won't type.", { id: "open-in-editor" });
      return;
    }
    useAppStore.getState().addTerminalTab(`${editor} ${shellQuote(dirPath)}`);
    return;
  }

  window.electronAPI.shell.openInEditor(dirPath);
}
