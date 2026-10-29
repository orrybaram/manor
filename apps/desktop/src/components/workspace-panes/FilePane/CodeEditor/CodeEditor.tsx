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
import { joinBom, lineSeparatorOf, splitBom } from "../file-text";
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
  // The clean copy, split as the editor splits it, and whether it had a BOM.
  const cleanRef = useRef<{ text: Text; bom: boolean } | null>(null);
  // The BOM the editor's text carries; it is never part of the document.
  const bomRef = useRef(false);
  const dirtyRef = useRef(false);
  const separator = useRef(new Compartment());

  const isDirty = (view: EditorView) => {
    const clean = cleanRef.current;
    if (!clean) return false;
    return bomRef.current !== clean.bom || !view.state.doc.eq(clean.text);
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
      const { bom, text } = splitBom(content);
      view.dispatch({
        effects: separator.current.reconfigure(separatorExtension(text)),
      });
      const clean = view.state.toText(text);
      cleanRef.current = { text: clean, bom };
      bomRef.current = bom;
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
      return view ? joinBom(bomRef.current, view.state.sliceDoc()) : "";
    },
    markClean(written: string) {
      const view = viewRef.current;
      if (!view) return false;
      const { bom, text } = splitBom(written);
      cleanRef.current = { text: view.state.toText(text), bom };
      return settle(view);
    },
  }));

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const clean = splitBom(base);
    const shown = draft !== null ? splitBom(draft) : clean;
    bomRef.current = shown.bom;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: shown.text,
        extensions: [
          separator.current.of(separatorExtension(shown.text)),
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
    cleanRef.current = { text: view.state.toText(clean.text), bom: clean.bom };
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
      onDispose(joinBom(bomRef.current, view.state.sliceDoc()), dirtyRef.current);
      viewRef.current = null;
      view.destroy();
    };
  });

  return <div ref={hostRef} className={styles.editor} data-testid="file-pane-editor" />;
}

/**
 * A CRLF file keeps its CRLFs: the editor splits and joins lines on them
 * alone. Anything else uses CodeMirror's default (split on any, join on LF).
 */
function separatorExtension(text: string) {
  const sep = lineSeparatorOf(text);
  return sep ? EditorState.lineSeparator.of(sep) : [];
}
