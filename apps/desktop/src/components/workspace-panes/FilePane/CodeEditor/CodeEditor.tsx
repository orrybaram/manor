import { useImperativeHandle, useRef, type Ref } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
} from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { onUiRequest } from "../../../../utils/ui-request";
import { languageFor, loadLanguage } from "../file-languages";
import { manorEditorTheme } from "../editor-theme";
import styles from "./CodeEditor.module.css";

export type CodeEditorRef = {
  /** Show `content` instead, keeping the scroll and selection where they fit. */
  replaceContent(content: string): void;
};

type CodeEditorProps = {
  /** The pane it is in, for Edit › Find… aimed at it. */
  paneId: string;
  /** Workspace-relative path; picks the language. */
  path: string;
  /** What the editor opens with. Later content goes through `replaceContent`. */
  initialContent: string;
  ref?: Ref<CodeEditorRef>;
};

/**
 * A read-only CodeMirror 6 view of one file. Mount it keyed by the file: the
 * view is made once, on mount, and its language pack arrives when loaded.
 */
export function CodeEditor({ paneId, path, initialContent, ref }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useImperativeHandle(ref, () => ({
    replaceContent(content: string) {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === content) return;
      const head = Math.min(view.state.selection.main.head, content.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        selection: { anchor: head },
      });
    },
  }));

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(true),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          drawSelection(),
          codeFolding(),
          foldGutter(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
          manorEditorTheme,
          language.of([]),
        ],
      }),
    });
    viewRef.current = view;

    let destroyed = false;
    const lang = languageFor(path);
    if (lang) {
      loadLanguage(lang)
        .then((extension) => {
          if (!destroyed) view.dispatch({ effects: language.reconfigure(extension) });
        })
        .catch(() => {
          // No pack is plain text, which the editor already shows.
        });
    }
    // Edit › Find… (⌘F from the menu) names the focused pane.
    const stopFind = onUiRequest((request) => {
      if (request.type === "pane-search" && request.paneId === paneId) {
        openSearchPanel(view);
      }
    });
    return () => {
      destroyed = true;
      stopFind();
      viewRef.current = null;
      view.destroy();
    };
  });

  return <div ref={hostRef} className={styles.editor} data-testid="file-pane-editor" />;
}
