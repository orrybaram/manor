import { useEffect, useRef, useState, type RefObject } from "react";
import * as Popover from "@radix-ui/react-popover";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ClipboardCopy from "lucide-react/dist/esm/icons/clipboard-copy";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import type { AgentInfo } from "../../../electron.d";
import type { AgentTarget } from "../../../lib/agent-send";
import { noteCountLabel, notesWhereLabel, type PageNote } from "../../../lib/page-notes";
import { Button } from "../../ui/Button/Button";
import { AgentTargetMenu, AgentTargetMenuItem } from "../../review/ReviewSend/ReviewSend";
import { parseWorkspaceKey, type WorkspaceKey } from "../../../lib/workspace-key";
import { useSendableAgents } from "../../review/ReviewSend/useReviewSend";
import { placeNotePopover, toPaneRect, typingElsewhere, type Rect, type Size } from "./note-placement";
import type { PageNotes } from "./usePageNotes";

import styles from "./BrowserPane.module.css";

/**
 * Everything of the notes drawn by the pane over its page: the picking hint,
 * the open note's popover (from the rects the page reports) and the pill.
 * The pins themselves are drawn in the page.
 */
export function PageNotesOverlay({
  pageNotes,
  picking,
  pageUrl,
  workspaceKey,
  webviewRef,
}: {
  pageNotes: PageNotes;
  picking: boolean;
  pageUrl: string;
  workspaceKey?: WorkspaceKey;
  webviewRef: RefObject<HTMLElement | null>;
}) {
  const { notes, layout, openId } = pageNotes;
  const workspace = workspaceKey ? parseWorkspaceKey(workspaceKey) : null;
  const agents = useSendableAgents(workspace?.path ?? "", workspace?.hostId);

  // The page's box in the pane, which the page's rects scale into.
  const layerRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const observer = new ResizeObserver(() =>
      setPane({ width: layer.clientWidth, height: layer.clientHeight }),
    );
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  const openIndex = notes.findIndex((n) => n.id === openId);
  const openPin = layout?.pins.find((p) => p.id === openId);
  const backToPage = () => webviewRef.current?.focus();

  return (
    <div ref={layerRef} className={styles.notesLayer}>
      {picking && <PickingHint />}
      {openIndex >= 0 && openPin && layout && pane.width > 0 && (
        <PinNotePopover
          key={openId}
          note={notes[openIndex]}
          number={openIndex + 1}
          element={toPaneRect(openPin, layout.viewport.width, pane.width)}
          pane={pane}
          onChange={(text) => pageNotes.setNote(notes[openIndex].id, text)}
          onDone={() => {
            pageNotes.setOpenId(null);
            backToPage();
          }}
          onDelete={() => {
            pageNotes.remove(notes[openIndex].id);
            backToPage();
          }}
        />
      )}
      {notes.length > 0 && (
        <NotesPill
          notes={notes}
          pageUrl={pageUrl}
          agents={agents}
          onCopy={() => void pageNotes.copy()}
          onSend={(target) => void pageNotes.send(target)}
          onClear={pageNotes.clear}
        />
      )}
    </div>
  );
}

/** Over the page while picking: how to collect, and how to stop. */
export function PickingHint() {
  return (
    <div className={styles.pickingHint} data-floats-over-panes data-testid="browser-picking-hint">
      Click elements to collect them · <kbd className={styles.kbd}>Esc</kbd> to stop
    </div>
  );
}

/** Popover width; matches `.notePopover`. */
const POPOVER_WIDTH = 240;

/**
 * One note, beside its pin: the selector, the note itself, and Save. Typing
 * writes the note as it goes, so picking the next element keeps it; Escape
 * puts back what it said when the popover opened.
 */
export function PinNotePopover({
  note,
  number,
  element,
  pane,
  onDone,
  onDelete,
  onChange,
}: {
  note: PageNote;
  number: number;
  /** Its element, in the pane's pixels. */
  element: Rect;
  pane: Size;
  /** Close it, the note kept or (Escape) put back. */
  onDone: () => void;
  onDelete: () => void;
  onChange: (text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Into the note — unless the user is typing somewhere else (a terminal,
  // another field): a note that opens on its own never takes their keys.
  useEffect(() => {
    if (!typingElsewhere(document.activeElement, ref.current)) inputRef.current?.focus();
  }, []);
  // What Escape puts back.
  const [openedWith] = useState(note.note);
  // Its own height decides whether it fits under the element.
  const [height, setHeight] = useState(96);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setHeight(box.offsetHeight));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const { left, top } = placeNotePopover(element, pane, { width: POPOVER_WIDTH, height });

  return (
    <div
      ref={ref}
      className={styles.notePopover}
      style={{ left, top }}
      data-floats-over-panes
      data-testid="browser-note-popover"
    >
      <div className={styles.noteHeader}>
        <span className={styles.noteNumber}>{number}</span>
        <span className={styles.noteSelector} title={note.selector}>
          {note.selector}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className={styles.noteIconButton}
          aria-label="Delete note"
          onClick={onDelete}
        >
          <Trash2 size={12} />
        </Button>
      </div>
      <input
        className={styles.noteInput}
        value={note.note}
        placeholder="Add a note (optional)"
        ref={inputRef}
        spellCheck={false}
        data-testid="browser-note-input"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (note.note !== openedWith) onChange(openedWith);
            onDone();
          }
        }}
      />
      <div className={styles.noteFooter}>
        <span className={styles.noteKeys}>
          <kbd className={styles.kbd}>↵</kbd> save · <kbd className={styles.kbd}>Esc</kbd> skip
        </span>
        <Button variant="primary" size="sm" onClick={onDone} data-testid="browser-note-save">
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * The queue, floating at the bottom of the page: how many notes, Copy, and
 * Send to… with the review's destinations plus the clipboard.
 */
export function NotesPill({
  notes,
  pageUrl,
  agents,
  onCopy,
  onSend,
  onClear,
}: {
  notes: PageNote[];
  pageUrl: string;
  agents: AgentInfo[];
  onCopy: () => void;
  onSend: (target: AgentTarget) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const pick = (target: AgentTarget) => {
    setOpen(false);
    onSend(target);
  };

  return (
    <div className={styles.notesPill} data-floats-over-panes data-testid="browser-notes-pill">
      <span className={styles.notesCount}>
        <strong>{noteCountLabel(notes.length)}</strong>{" "}
        <span className={styles.notesWhere}>{notesWhereLabel(notes, pageUrl)}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onCopy} data-testid="browser-notes-copy">
        Copy
      </Button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <Button variant="primary" size="sm" className={styles.notesSend} data-testid="browser-notes-send">
            Send to…
            <ChevronDown size={12} />
          </Button>
        </Popover.Trigger>
        <AgentTargetMenu agents={agents} onPick={pick} testId="browser-notes-targets">
          <AgentTargetMenuItem
            icon={<ClipboardCopy size={12} />}
            label="Copy to clipboard"
            onSelect={() => {
              setOpen(false);
              onCopy();
            }}
          />
        </AgentTargetMenu>
      </Popover.Root>
      <Button
        variant="ghost"
        size="sm"
        className={styles.noteIconButton}
        aria-label="Clear notes"
        onClick={onClear}
      >
        <X size={12} />
      </Button>
    </div>
  );
}
