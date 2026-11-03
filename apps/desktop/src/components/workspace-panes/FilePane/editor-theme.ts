import { EditorView } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/**
 * The editor's look, all from manor's CSS variables: the chrome from the
 * surface tokens and the syntax from the terminal theme's ANSI colours. The
 * variables change with the terminal theme and light/dark, so the editor
 * follows without being told. Its font is Settings' (`useEditorFont`).
 */
const chrome = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--fg)",
    backgroundColor: "var(--bg)",
    fontSize: "var(--editor-font-size, 12px)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font-family, var(--font-mono))",
    // 17px at the default 12px, in proportion at any other size.
    lineHeight: "calc(var(--editor-font-size, 12px) * 17 / 12)",
  },
  ".cm-content": { padding: "6px 0", caretColor: "var(--fg)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
    { backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--text-dim)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "38px",
    padding: "0 8px 0 4px",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-primary)" },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 6px 0 2px",
    color: "var(--text-dim)",
    cursor: "pointer",
  },
  // Room between the gutter (and a line's change bar) and the text.
  ".cm-line": { paddingLeft: "10px" },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--surface)",
    border: "none",
    color: "var(--text-primary)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--yellow) 22%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--yellow) 45%, transparent)",
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 45%, transparent)",
    outline: "1px solid var(--accent)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--hover)" },
  ".cm-matchingBracket, .cm-nonmatchingBracket": {
    backgroundColor: "var(--surface)",
    outline: "none",
  },
  // The find widget (`search-panel.tsx`) floats over the text's top right
  // instead of pushing it down; its own module styles the rest.
  ".cm-panels.cm-panels-top": {
    position: "absolute",
    top: "6px",
    left: "auto",
    right: "14px",
    maxWidth: "calc(100% - 28px)",
    zIndex: 10,
    backgroundColor: "transparent",
    border: "none",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface)",
    color: "var(--fg)",
    border: "1px solid var(--border)",
  },
});

const syntax = HighlightStyle.define([
  { tag: [t.comment, t.meta], color: "var(--text-dim)", fontStyle: "italic" },
  {
    tag: [t.keyword, t.tagName, t.bool, t.null, t.atom, t.modifier, t.controlKeyword],
    color: "var(--magenta)",
  },
  { tag: [t.string, t.special(t.string), t.attributeValue, t.character], color: "var(--green)" },
  { tag: [t.number, t.regexp, t.escape, t.special(t.variableName)], color: "var(--yellow)" },
  {
    tag: [
      t.function(t.variableName),
      t.function(t.propertyName),
      t.className,
      t.typeName,
      t.definition(t.typeName),
    ],
    color: "var(--blue)",
  },
  {
    tag: [t.standard(t.variableName), t.propertyName, t.attributeName, t.labelName],
    color: "var(--cyan)",
  },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.url], color: "var(--text-dim)" },
  { tag: t.heading, color: "var(--blue)", fontWeight: "bold" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.link, color: "var(--cyan)", textDecoration: "underline" },
  { tag: t.invalid, color: "var(--red)" },
]);

/** The file pane's editor theme: chrome and syntax, from manor's tokens. */
/**
 * Where `useEditorFont` swaps in a font changed in Settings. The CSS variables
 * already restyle an open view, but CodeMirror keeps the line heights it
 * measured until its theme changes, and the gutter then drifts from the text.
 * Empty in a new view, which measures the variables as they stand.
 */
export const editorFont = new Compartment();

/** The font as a theme, the same values as the CSS variables `chrome` reads. */
export function editorFontTheme(font: { family: string; size: number }) {
  return EditorView.theme({
    "&": { fontSize: `${font.size}px` },
    ".cm-scroller": {
      fontFamily: font.family,
      lineHeight: `calc(${font.size}px * 17 / 12)`,
    },
  });
}

export const manorEditorTheme = [chrome, syntaxHighlighting(syntax), editorFont.of([])];
