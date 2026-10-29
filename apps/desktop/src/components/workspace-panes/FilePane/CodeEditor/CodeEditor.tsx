import { useImperativeHandle, useRef, type Ref } from "react";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { readFileText, writeFileText, type FileFormat } from "../file-text";
import styles from "./CodeEditor.module.css";

export type CodeEditorRef = {
  /**
   * Show `content` as the clean copy, dropping any edits, and keep the
   * selection where it fits.
   */
  replaceContent(content: string): void;
  /** What a save writes: the text, its own line breaks and any BOM. */
  content(): string;
  /** `written` is now on disk. Returns whether the editor still differs from it. */
  markClean(written: string): boolean;
};

type CodeEditorProps = {
  /** The pane it is in, for Edit › Find… aimed at it. */
  paneId: string;
  /** Workspace-relative path; picks the language. */
  path: string;
  /** The clean copy: what is on disk. Later ones go through `replaceContent`. */
  base: string;
  /** Unsaved edits to show instead of `base`, kept across a remount. */
  draft: string | null;
  /** The phone: shown, never edited, and no soft keyboard. */
  readOnly: boolean;
  /** Read once, on mount: the text started or stopped differing from the clean copy. */
  onDirtyChange: (dirty: boolean) => void;
  /** Read once, on mount: the editor is going away, with this text. */
  onDispose: (content: string, dirty: boolean) => void;
  ref?: Ref<CodeEditorRef>;
};

/**
 * A CodeMirror 6 editor for one file. Mount it keyed by the file: the view is
 * made once, on mount, and its language pack arrives when loaded. It says
 * when the text starts or stops differing from the clean copy; saving is the
 * pane's.
 */
export function CodeEditor({
  paneId,
  path,
  base,
  draft,
  readOnly,
  onDirtyChange,
  onDispose,
  ref,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The clean copy, split as the editor splits it, and how it was written.
  const cleanRef = useRef<{ text: Text; format: FileFormat } | null>(null);
  // How a save writes the editor's text: its BOM (never part of the
  // document) and its line breaks (the document's are normalized).
  const formatRef = useRef<FileFormat>({ bom: false, crlf: false });
  const dirtyRef = useRef(false);

  const isDirty = (view: EditorView) => {
    const clean = cleanRef.current;
    if (!clean) return false;
    return (
      formatRef.current.bom !== clean.format.bom ||
      formatRef.current.crlf !== clean.format.crlf ||
      !view.state.doc.eq(clean.text)
    );
  };
  const settle = (view: EditorView) => {
    const dirty = isDirty(view);
    if (dirty === dirtyRef.current) return dirty;
    dirtyRef.current = dirty;
    onDirtyChange(dirty);
    return dirty;
  };

  useImperativeHandle(ref, () => ({
    replaceContent(content: string) {
      const view = viewRef.current;
      if (!view) return;
      const { format, text } = readFileText(content);
      const clean = view.state.toText(text);
      cleanRef.current = { text: clean, format };
      formatRef.current = format;
      if (!view.state.doc.eq(clean)) {
        const head = Math.min(view.state.selection.main.head, clean.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: clean },
          selection: { anchor: head },
        });
      }
      settle(view);
    },
    content() {
      const view = viewRef.current;
      return view ? writeFileText(formatRef.current, view.state.doc) : "";
    },
    markClean(written: string) {
      const view = viewRef.current;
      if (!view) return false;
      const { format, text } = readFileText(written);
      cleanRef.current = { text: view.state.toText(text), format };
      return settle(view);
    },
  }));

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const clean = readFileText(base);
    const shown = draft !== null ? readFileText(draft) : clean;
    // A draft carries the breaks the file was loaded with, unless it has
    // none to tell (one line): then the file's own.
    formatRef.current = {
      bom: shown.format.bom,
      crlf: draft !== null && /[\r\n]/.test(shown.text) ? shown.format.crlf : clean.format.crlf,
    };
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: shown.text,
        extensions: [
          EditorState.readOnly.of(readOnly),
          // Not editable on the phone, so a tap never opens the keyboard.
          EditorView.editable.of(!readOnly),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          codeFolding(),
          foldGutter(),
          bracketMatching(),
          highlightSelectionMatches(),
          search({ top: true }),
          keymap.of([
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) settle(update.view);
          }),
          manorEditorTheme,
          language.of([]),
        ],
      }),
    });
    viewRef.current = view;
    cleanRef.current = { text: view.state.toText(clean.text), format: clean.format };
    dirtyRef.current = isDirty(view);
    if (dirtyRef.current) onDirtyChange(true);

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
      onDispose(writeFileText(formatRef.current, view.state.doc), dirtyRef.current);
      viewRef.current = null;
      view.destroy();
    };
  });

  return <div ref={hostRef} className={styles.editor} data-testid="file-pane-editor" />;
}
