import { useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { languageFor, loadLanguage } from "../file-languages";
import { manorEditorTheme } from "../editor-theme";
import { unifiedDiff } from "./diff-view";
import styles from "./CodeEditor.module.css";

/**
 * A deleted file's diff: all of its old side, removed, read-only. There is
 * no working file to edit; restoring it is Source Control's Discard.
 */
export function DeletedFileView({ path, base }: { path: string; base: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<((base: string) => void) | null>(null);

  // A fresher diff hands its old side over, as the editor's diff does.
  useLayoutEffect(() => {
    showRef.current?.(base);
  }, [base]);

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const diff = new Compartment();
    const language = new Compartment();
    let shown = base;
    let destroyed = false;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          manorEditorTheme,
          language.of([]),
          diff.of(unifiedDiff(base)),
        ],
      }),
    });
    showRef.current = (next) => {
      if (destroyed || next === shown) return;
      shown = next;
      view.dispatch({ effects: diff.reconfigure(unifiedDiff(next)) });
    };
    const lang = languageFor(path);
    if (lang) {
      loadLanguage(lang)
        .then((extension) => {
          if (!destroyed) view.dispatch({ effects: language.reconfigure(extension) });
        })
        .catch(() => {
          // Plain text is still a diff.
        });
    }
    return () => {
      destroyed = true;
      showRef.current = null;
      view.destroy();
    };
  });

  return (
    <div className={styles.frame}>
      <div ref={hostRef} className={styles.editor} data-testid="file-pane-deleted-diff" />
    </div>
  );
}
