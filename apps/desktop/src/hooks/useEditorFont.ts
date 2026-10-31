import { useLayoutEffect } from "react";
import { EditorView } from "@codemirror/view";
import {
  editorFont,
  editorFontTheme,
} from "../components/workspace-panes/FilePane/editor-theme";
import { usePreferencesStore } from "../store/preferences-store";
import { isWebApp } from "../lib/platform";
import { clampFontSize } from "../terminal/config";

const DEFAULT_EDITOR_FONT_SIZE = 12;

/** The editor's font: a CSS stack and a size in px. */
export interface EditorFont {
  family: string;
  size: number;
}

/** The editor font for a family and size preference; empty family means the system monospace. */
export function resolveEditorFont(family: string, size: unknown): EditorFont {
  const name = family.replace(/["\\]/g, "").trim();
  return {
    family: name ? `"${name}", var(--font-mono)` : "var(--font-mono)",
    size: clampFontSize(size, DEFAULT_EDITOR_FONT_SIZE),
  };
}

/**
 * Put the editor font from Settings on the document, where every CodeMirror
 * view in the window reads it (`editor-theme`), so an open file or diff
 * redraws without being reopened. Not in a phone or browser tab: the
 * preference is the desktop's, and its fonts are rarely installed there, so
 * `editor-theme`'s defaults stand.
 */
export function useEditorFont(): void {
  const family = usePreferencesStore((s) => s.preferences.editorFontFamily);
  const size = usePreferencesStore((s) => s.preferences.editorFontSize);
  useLayoutEffect(() => {
    if (isWebApp()) return;
    const font = resolveEditorFont(family ?? "", size);
    const root = document.documentElement.style;
    root.setProperty("--editor-font-family", font.family);
    root.setProperty("--editor-font-size", `${font.size}px`);
    // An open view keeps the line heights it measured until its theme
    // changes: give each one the font as a theme (`editorFont`).
    for (const el of document.querySelectorAll<HTMLElement>(".cm-editor")) {
      EditorView.findFromDOM(el)?.dispatch({
        effects: editorFont.reconfigure(editorFontTheme(font)),
      });
    }
  }, [family, size]);
}
