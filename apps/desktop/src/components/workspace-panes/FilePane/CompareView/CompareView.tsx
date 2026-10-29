import { useRef } from "react";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView } from "@codemirror/merge";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { languageFor, loadLanguage } from "../file-languages";
import { manorEditorTheme } from "../editor-theme";
import styles from "./CompareView.module.css";

type CompareViewProps = {
  /** Workspace-relative path; picks the language. */
  path: string;
  /** What is on disk now. */
  theirs: string;
  /** Your unsaved copy. */
  mine: string;
};

const readOnly: Extension = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  lineNumbers(),
  manorEditorTheme,
];

/** The merge view's colours, from manor's tokens: removed red, added green. */
const compareTheme = EditorView.theme({
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, var(--red) 12%, transparent)",
  },
  "&.cm-merge-b .cm-changedLine, .cm-insertedLine": {
    backgroundColor: "color-mix(in srgb, var(--green) 12%, transparent)",
  },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
    background: "color-mix(in srgb, var(--red) 30%, transparent)",
  },
  "&.cm-merge-b .cm-changedText": {
    background: "color-mix(in srgb, var(--green) 30%, transparent)",
  },
  ".cm-collapsedLines": {
    backgroundColor: "var(--surface)",
    backgroundImage: "none",
    color: "var(--text-dim)",
  },
});

/**
 * A read-only side-by-side diff of the file on disk (left) and your copy
 * (right), long unchanged stretches folded away.
 */
export function CompareView({ path, theirs, mine }: CompareViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new MergeView({
      a: { doc: theirs, extensions: [readOnly, compareTheme] },
      b: { doc: mine, extensions: [readOnly, compareTheme] },
      parent: host,
      collapseUnchanged: { margin: 3, minSize: 6 },
      gutter: true,
    });
    let destroyed = false;
    const lang = languageFor(path);
    if (lang) {
      loadLanguage(lang)
        .then((extension) => {
          if (destroyed) return;
          for (const side of [view.a, view.b]) {
            side.dispatch({ effects: StateEffect.appendConfig.of(extension) });
          }
        })
        .catch(() => {
          // Plain text is still a diff.
        });
    }
    return () => {
      destroyed = true;
      view.destroy();
    };
  });

  return <div ref={hostRef} className={styles.compare} data-testid="file-pane-compare-view" />;
}
