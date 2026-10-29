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
import { EditorFile } from "../file-text";
import { pendingLines, type LineRequest } from "../pending-line";
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
  // How a save writes the editor's text (its BOM, never part of the
  // document, and the file's line breaks, which the document normalizes),
  // and the clean copy it is dirty against.
  const fileRef = useRef<EditorFile | null>(null);
  const dirtyRef = useRef(false);

  const isDirty = (view: EditorView) => fileRef.current?.isDirty(view.state.doc) ?? false;
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
      const file = fileRef.current;
      if (!view || !file) return;
      const { text: clean } = file.replace(content);
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
      const file = fileRef.current;
      return view && file ? file.write(view.state.doc) : "";
    },
    markClean(written: string) {
      const view = viewRef.current;
      const file = fileRef.current;
      if (!view || !file) return false;
      file.markClean(written);
      return settle(view);
    },
  }));

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const { file, shown } = EditorFile.open(base, draft);
    fileRef.current = file;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: shown,
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
    // A terminal link's `:line:col`, asked for before or after this opened.
    const showPendingLine = () => {
      const request = pendingLines.take(paneId, path);
      if (request) showLine(view, request);
    };
    showPendingLine();
    const stopLines = pendingLines.subscribe(paneId, showPendingLine);
    // Edit › Find… (⌘F from the menu) names the focused pane.
    const stopFind = onUiRequest((request) => {
      if (request.type === "pane-search" && request.paneId === paneId) {
        openSearchPanel(view);
      }
    });
    return () => {
      destroyed = true;
      stopFind();
      stopLines();
      onDispose(file.write(view.state.doc), dirtyRef.current);
      viewRef.current = null;
      view.destroy();
    };
  });

  return <div ref={hostRef} className={styles.editor} data-testid="file-pane-editor" />;
}

/** Put the cursor on `request`'s line (and column), centred, with the keyboard. */
function showLine(view: EditorView, { line, col }: LineRequest): void {
  const doc = view.state.doc;
  const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const pos = target.from + Math.min(Math.max((col ?? 1) - 1, 0), target.length);
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}
