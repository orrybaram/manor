import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { createElement, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { ipcErrorMessage } from "../../../../lib/ipc-error";
import { fileIconFor } from "../../FileTree/file-icon";
import type { FilesWorkspace } from "../open-file-watches";
import {
  filterEntries,
  folderEntries,
  parentFolder,
  startIndex,
  type FolderEntry,
} from "../breadcrumb-picker";
import styles from "./BreadcrumbPicker.module.css";

/** A listing a few seconds old is good enough to walk; the drawer and ⌘P refresh it. */
const LISTING_FRESH_MS = 30_000;

type BreadcrumbSegmentProps = {
  workspace: FilesWorkspace;
  /** The segment's text. */
  label: string;
  /** Its place in the breadcrumb, for its test id. */
  index: number;
  /** The folder its picker opens on, workspace-relative ("" for the root). */
  folder: string;
  /** The pane's open file, workspace-relative: its entry is lit. */
  openFile: string;
  className: string;
  onOpenFile: (path: string) => void;
  onReveal: (folder: string) => void;
};

/**
 * A breadcrumb segment that opens a picker of its folder's entries (the
 * file's segment, its own folder's): type to narrow, ↑↓ to move, Enter to
 * open a file or step into a folder, ← or Backspace on an empty filter to
 * step out, Escape to close. Read off the workspace's cached `files.list`.
 */
export function BreadcrumbSegment({
  workspace,
  label,
  index,
  folder,
  openFile,
  className,
  onOpenFile,
  onReveal,
}: BreadcrumbSegmentProps) {
  const [open, setOpen] = useState(false);
  // Closed by a pick: focus goes where the pick sends it, not back here.
  const [picked, setPicked] = useState(false);
  // A file pick lets focus come back here: the open remounts the pane's
  // breadcrumb and the editor takes the keyboard, and if the swap bar asks
  // first (unsaved edits) the keyboard is still somewhere it can act from.
  const close = (keepFocus: boolean) => {
    setPicked(keepFocus);
    setOpen(false);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPicked(false);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`${className} ${styles.segment}`}
          data-testid={`file-pane-crumb-${index}`}
        >
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.picker}
          data-testid="breadcrumb-picker"
          align="start"
          sideOffset={2}
          collisionPadding={8}
          onCloseAutoFocus={(e) => {
            if (picked) e.preventDefault();
          }}
          // Escape closes only the picker: React bubbles it, through the
          // portal, to the pane and the editor.
          onKeyDown={(e) => {
            if (e.key === "Escape") e.stopPropagation();
          }}
        >
          <PickerBody
            workspace={workspace}
            startFolder={folder}
            openFile={openFile}
            onOpenFile={(path) => {
              close(false);
              onOpenFile(path);
            }}
            onReveal={(at) => {
              close(true);
              onReveal(at);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A row of the picker: one of the folder's entries, or Reveal in Files. */
type PickerRow = FolderEntry | { kind: "reveal" };

function PickerBody({
  workspace,
  startFolder,
  openFile,
  onOpenFile,
  onReveal,
}: {
  workspace: FilesWorkspace;
  startFolder: string;
  openFile: string;
  onOpenFile: (path: string) => void;
  onReveal: (folder: string) => void;
}) {
  const listing = useQuery({
    queryKey: ["files.list", workspace.hostId, workspace.path],
    queryFn: () => window.electronAPI.files.list(workspace),
    staleTime: LISTING_FRESH_MS,
  });
  const paths = listing.data?.paths ?? null;
  const [folder, setFolder] = useState(startFolder);
  const [query, setQuery] = useState("");
  // The entry the keyboard is on, by path, so a listing that lands or a
  // narrowing filter keeps it where it can. Null: the one on the way to the
  // open file (or the folder just stepped out of).
  const [cursorPath, setCursorPath] = useState<string | null>(null);
  const [cursorFrom, setCursorFrom] = useState<string>(openFile);
  // The cursor row scrolls into view only when the keyboard (or a new folder)
  // put it there: following the pointer, a scroll would move the row under
  // it, and the list would creep.
  const scrollToCursor = useRef(true);

  const entries = useMemo(
    () => (paths ? folderEntries(paths, folder) : []),
    [paths, folder],
  );
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
  const rows: PickerRow[] = [...shown, { kind: "reveal" }];
  const at = shown.findIndex((e) => e.path === cursorPath);
  const cursor =
    at >= 0
      ? at
      : cursorPath === ""
        ? shown.length
        : startIndex(shown, cursorFrom);

  const goTo = (next: string, from: string) => {
    scrollToCursor.current = true;
    setFolder(next);
    setQuery("");
    setCursorPath(null);
    setCursorFrom(from);
  };

  const choose = (row: PickerRow) => {
    if (row.kind === "reveal") onReveal(folder);
    else if (row.kind === "dir") goTo(row.path, openFile);
    else onOpenFile(row.path);
  };

  const move = (index: number) => {
    scrollToCursor.current = true;
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    // "" stands for Reveal in Files, which has no path.
    setCursorPath(row.kind === "reveal" ? "" : row.path);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(cursor + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        move(cursor - 1);
        return;
      case "Enter":
        e.preventDefault();
        choose(rows[cursor]);
        return;
      case "ArrowLeft":
      case "Backspace": {
        if (query !== "") return;
        e.preventDefault();
        const up = parentFolder(folder);
        if (up !== null) goTo(up, `${folder}/`);
        return;
      }
    }
  };

  return (
    <>
      <div className={styles.head} data-testid="breadcrumb-picker-path">
        {folder === "" ? "./" : `${folder}/`}
      </div>
      <input
        className={styles.filter}
        data-testid="breadcrumb-picker-filter"
        aria-label={`Filter ${folder || "workspace root"}`}
        placeholder="Filter"
        value={query}
        spellCheck={false}
        autoFocus
        onChange={(e) => {
          scrollToCursor.current = true;
          setQuery(e.target.value);
          setCursorPath(null);
        }}
        onKeyDown={onKeyDown}
      />
      <div
        className={styles.list}
        role="listbox"
        aria-label={folder || "Workspace root"}
      >
        {paths === null ? (
          <div className={styles.note}>
            {listing.isError ? ipcErrorMessage(listing.error) : "Loading…"}
          </div>
        ) : shown.length === 0 ? (
          <div className={styles.note}>
            {entries.length === 0 ? "Empty" : "No matches"}
          </div>
        ) : (
          shown.map((entry, i) => (
            <button
              key={entry.path}
              type="button"
              role="option"
              aria-selected={i === cursor}
              tabIndex={-1}
              className={`${styles.item} ${i === cursor ? styles.itemCursor : ""} ${entry.path === openFile ? styles.itemOpen : ""}`}
              data-testid="breadcrumb-picker-entry"
              data-kind={entry.kind}
              data-path={entry.path}
              title={entry.path}
              ref={
                i === cursor
                  ? (el) => {
                      if (!el || !scrollToCursor.current) return;
                      scrollToCursor.current = false;
                      el.scrollIntoView({ block: "nearest" });
                    }
                  : undefined
              }
              onMouseMove={() => {
                if (i === cursor) return;
                scrollToCursor.current = false;
                setCursorPath(entry.path);
              }}
              onClick={() => choose(entry)}
            >
              <span
                className={entry.kind === "dir" ? styles.dirMark : styles.icon}
              >
                {entry.kind === "dir"
                  ? <ChevronRight size={12} aria-hidden />
                  : createElement(fileIconFor(entry.path), { size: 12 })}
              </span>
              <span className={styles.name}>{entry.name}</span>
            </button>
          ))
        )}
      </div>
      <div className={styles.sep} />
      <button
        type="button"
        tabIndex={-1}
        className={`${styles.item} ${cursor === shown.length ? styles.itemCursor : ""}`}
        data-testid="breadcrumb-picker-reveal"
        onMouseMove={() => cursor !== shown.length && setCursorPath("")}
        onClick={() => onReveal(folder)}
      >
        <span className={styles.icon}>◎</span>
        <span className={styles.name}>Reveal in Files</span>
      </button>
    </>
  );
}
