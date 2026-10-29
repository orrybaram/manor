import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Compartment, EditorState, Prec } from "@codemirror/state";
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
import { stepEdit } from "../file-changes";
import { registerEditJumper, useFileEditNav } from "../file-edit-nav";
import {
  agentEdits,
  changeMarks,
  flashLine,
  laneMarks,
  setAgentMarks,
  setCleanDoc,
  type AgentMarks,
  type LaneMark,
} from "./change-marks";
import styles from "./CodeEditor.module.css";

/** How long a line jumped to stays lit. */
const FLASH_MS = 1200;

/** Where the open file's change marks come from: `follow` hears each new set. */
export type AgentMarksSource = {
  follow(onChange: (marks: AgentMarks | null) => void): () => void;
};

type Lane = { marks: LaneMark[]; lines: number };

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
  /** Read once, on mount: the file's changed lines, as the workspace diff has them. */
  agentMarks?: AgentMarksSource;
  ref?: Ref<CodeEditorRef>;
};

/**
 * A CodeMirror 6 editor for one file. Mount it keyed by the file: the view is
 * made once, on mount, and its language pack arrives when loaded. It says
 * when the text starts or stops differing from the clean copy; saving is the
 * pane's.
 *
 * Its gutter marks the file's changes since the last commit (orange, or
 * green for a new file) and your unsaved lines (blue), and a lane on its
 * right edge marks where they are in the whole file. ⌥↑/⌥↓, and the pane
 * header's ↑/↓ (`jumpToEdit`), move between the changes while nothing is
 * unsaved.
 */
export function CodeEditor({
  paneId,
  path,
  base,
  draft,
  readOnly,
  onDirtyChange,
  onDispose,
  agentMarks,
  ref,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [lane, setLane] = useState<Lane>({ marks: [], lines: 1 });
  /** Go to a lane mark's line, counting it as the edit it is; set on mount. */
  const markClickedRef = useRef<((mark: LaneMark) => void) | null>(null);
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
          effects: setCleanDoc.of(clean),
        });
      } else {
        view.dispatch({ effects: setCleanDoc.of(clean) });
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
      view.dispatch({ effects: setCleanDoc.of(file.cleanDoc) });
      return settle(view);
    },
  }));

  useMountEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const language = new Compartment();
    const { file, shown } = EditorFile.open(base, draft);
    fileRef.current = file;

    // The change last jumped to, for the header's "N of M".
    let current: number | null = null;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    let destroyed = false;
    // Lane and header follow the marks; re-set only when they changed.
    const publish = (view: EditorView) => {
      const edits = agentEdits(view.state);
      if (current !== null && current >= edits.length) current = null;
      useFileEditNav
        .getState()
        .set(paneId, edits.length > 0 ? { count: edits.length, current } : null);
      const marks = laneMarks(view.state);
      const lines = view.state.doc.lines;
      setLane((prev) =>
        prev.lines === lines && sameMarks(prev.marks, marks) ? prev : { marks, lines },
      );
    };
    const goTo = (view: EditorView, line: number) => {
      const target = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: [EditorView.scrollIntoView(target.from, { y: "center" }), flashLine.of(target.number)],
      });
      view.focus();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        if (!destroyed) view.dispatch({ effects: flashLine.of(null) });
      }, FLASH_MS);
    };
    const jump = (view: EditorView, direction: 1 | -1): boolean => {
      // Only while the header shows the jumps: with unsaved edits it says
      // "⌘S to save" instead, and ⌥↑/⌥↓ move the line.
      if (dirtyRef.current) return false;
      const edits = agentEdits(view.state);
      const next = stepEdit(edits.length, current, direction);
      if (next === null) return false;
      current = next;
      goTo(view, edits[next].from);
      publish(view);
      return true;
    };
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
          // ⌥↑/⌥↓ move between the changes; with none, or unsaved edits, they move the line.
          Prec.high(
            keymap.of([
              { key: "Alt-ArrowDown", run: (v) => jump(v, 1) },
              { key: "Alt-ArrowUp", run: (v) => jump(v, -1) },
            ]),
          ),
          changeMarks(file.cleanDoc),
          keymap.of([
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) settle(update.view);
            if (
              update.docChanged ||
              update.transactions.some((tr) =>
                tr.effects.some((e) => e.is(setAgentMarks) || e.is(setCleanDoc)),
              )
            ) {
              publish(update.view);
            }
          }),
          manorEditorTheme,
          language.of([]),
        ],
      }),
    });
    viewRef.current = view;
    dirtyRef.current = isDirty(view);
    if (dirtyRef.current) onDirtyChange(true);
    publish(view);
    markClickedRef.current = (mark) => {
      if (mark.kind === "agent") {
        const index = agentEdits(view.state).findIndex((e) => e.from === mark.from);
        if (index >= 0) current = index;
      }
      goTo(view, mark.from);
      publish(view);
    };
    const stopJumps = registerEditJumper(paneId, (direction) => {
      jump(view, direction);
    });
    const stopMarks = agentMarks?.follow((marks) => {
      if (!destroyed) view.dispatch({ effects: setAgentMarks.of(marks) });
    });

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
      clearTimeout(flashTimer);
      stopMarks?.();
      stopJumps();
      markClickedRef.current = null;
      useFileEditNav.getState().set(paneId, null);
      stopFind();
      stopLines();
      onDispose(file.write(view.state.doc), dirtyRef.current);
      viewRef.current = null;
      view.destroy();
    };
  });

  return (
    <div className={styles.frame}>
      <div ref={hostRef} className={styles.editor} data-testid="file-pane-editor" />
      <MarkLane lane={lane} onPick={(mark) => markClickedRef.current?.(mark)} />
    </div>
  );
}

function sameMarks(a: readonly LaneMark[], b: readonly LaneMark[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => m.from === b[i].from && m.to === b[i].to && m.kind === b[i].kind)
  );
}

const MARK_TITLES: Record<LaneMark["kind"], string> = {
  agent: "Changed",
  added: "New file",
  mine: "Unsaved",
};

/**
 * The 10px lane on the editor's right edge: a mark for each run of changed
 * lines, placed by its line in the whole file. Clicking one goes there.
 */
function MarkLane({ lane, onPick }: { lane: Lane; onPick: (mark: LaneMark) => void }) {
  return (
    <div className={styles.lane} data-testid="file-pane-mark-lane">
      {lane.marks.map((mark) => (
        <button
          key={`${mark.kind}:${mark.from}`}
          type="button"
          tabIndex={-1}
          className={`${styles.mark} ${styles[`mark_${mark.kind}`]}`}
          style={{
            top: `${((mark.from - 1) / lane.lines) * 100}%`,
            height: `max(4px, ${((mark.to - mark.from + 1) / lane.lines) * 100}%)`,
          }}
          title={`${MARK_TITLES[mark.kind]}: line ${mark.from}`}
          aria-label={`${MARK_TITLES[mark.kind]}: line ${mark.from}`}
          data-testid="file-pane-mark"
          data-kind={mark.kind}
          data-line={mark.from}
          // The editor keeps the keyboard.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(mark)}
        />
      ))}
    </div>
  );
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
