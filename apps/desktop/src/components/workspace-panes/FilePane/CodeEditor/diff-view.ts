import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { readFileText, toText } from "../file-text";

/**
 * The unified diff's colours, from manor's tokens so light and dark follow:
 * removed lines red and struck through, added lines green with a bar in the
 * gutter, and each folded stretch a clickable "⋯ N unchanged lines". The
 * merge view's own theme marks its editor `.cm-merge-b` and keys its (faint)
 * added-line colours on it, so ours do too, to outrank them. Green reads
 * weaker than red at the same mix, hence its larger share.
 */
const diffTheme = EditorView.theme({
  "&.cm-merge-b .cm-changedLine": {
    backgroundColor: "color-mix(in srgb, var(--green) 18%, transparent)",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--green) 36%, transparent)",
  },
  ".cm-deletedChunk": {
    paddingLeft: "0",
    backgroundColor: "color-mix(in srgb, var(--red) 12%, transparent)",
  },
  ".cm-deletedChunk .cm-deletedLine": {
    paddingLeft: "6px",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, var(--red) 60%, transparent)",
  },
  ".cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in srgb, var(--red) 30%, transparent)",
  },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--green)" },
  "&.cm-merge-b .cm-deletedLineGutter": { background: "var(--red)" },
  ".cm-collapsedLines": {
    padding: "3px 10px",
    backgroundColor: "var(--surface)",
    backgroundImage: "none",
    color: "var(--text-dim)",
    fontSize: "11px",
    "&:before": { content: '"⋯"', marginInlineEnd: "8px" },
    "&:after": { content: "none" },
    "&:hover": { color: "var(--fg)" },
  },
});

/**
 * Show the editor's text as a unified diff against `base` (the file as the
 * diff's old side has it, as read from disk): removed lines as blocks above
 * what replaced them, unchanged stretches folded. Typing re-diffs only what
 * changed; a long or very different file falls back to a coarser diff rather
 * than freezing.
 */
export function unifiedDiff(base: string): Extension {
  return [
    unifiedMergeView({
      original: toText(readFileText(base).text),
      mergeControls: false,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 4 },
      diffConfig: { scanLimit: 500, timeout: 200 },
    }),
    diffTheme,
  ];
}
