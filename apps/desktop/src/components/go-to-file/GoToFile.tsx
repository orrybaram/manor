import { useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { useQuery } from "@tanstack/react-query";
import FileCode from "lucide-react/dist/esm/icons/file-code";
import { useAppStore } from "../../store/app-store";
import { useRestoreFocus } from "../../hooks/useRestoreFocus";
import { openFileInActiveWorkspace } from "../../lib/open-in-file-pane";
import { normalizeHostId } from "../../lib/workspace-key";
import { isHomePath } from "../../lib/home";
import { rankFiles, type FileMatch } from "./file-match";
import paletteStyles from "../command-palette/CommandPalette.module.css";
import styles from "./GoToFile.module.css";

/** Rows shown at once: enough to pick from, few enough to render each keystroke. */
const RESULT_LIMIT = 50;

interface GoToFileProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Go to File (⌘P): the active workspace's files, fuzzy-matched as you type;
 * Enter opens the highlighted one in a file pane. Lists with the same
 * `files.list` query as the file pane's drawer, so each shares the other's
 * cached listing.
 */
export function GoToFile({ open, onClose }: GoToFileProps) {
  const path = useAppStore((s) => s.activeWorkspacePath);
  const hostId = useAppStore((s) => s.activeWorkspaceHostId);
  const workspace = useMemo(
    () =>
      path && !isHomePath(path)
        ? { path, hostId: normalizeHostId(hostId) }
        : null,
    [path, hostId],
  );
  const { onCloseAutoFocus: restoreFocus } = useRestoreFocus(open);
  // A pick focuses the file pane it opens in; restoring focus would undo it.
  const pickedRef = useRef(false);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={paletteStyles.overlay} />
        <Dialog.Content
          data-testid="go-to-file"
          aria-describedby={undefined}
          className={paletteStyles.palette}
          onOpenAutoFocus={() => {
            pickedRef.current = false;
          }}
          onCloseAutoFocus={(e) => {
            if (!pickedRef.current) return restoreFocus(e);
            e.preventDefault();
          }}
        >
          <Dialog.Title className="sr-only">Go to File</Dialog.Title>
          {workspace ? (
            <FileSearch
              workspace={workspace}
              onPick={(file) => {
                pickedRef.current = true;
                onClose();
                openFileInActiveWorkspace(file);
              }}
            />
          ) : (
            <div className={styles.status}>Open a workspace to go to its files.</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FileSearch({
  workspace,
  onPick,
}: {
  workspace: { path: string; hostId: string };
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const listing = useQuery({
    queryKey: ["files.list", workspace.hostId, workspace.path],
    queryFn: () => window.electronAPI.files.list(workspace),
    staleTime: 0,
  });
  const paths = listing.data?.paths ?? null;
  const matches = useMemo(
    () => (paths ? rankFiles(paths, query, RESULT_LIMIT) : []),
    [paths, query],
  );

  return (
    <Command className={paletteStyles.command} shouldFilter={false} loop>
      <Command.Input
        className={paletteStyles.input}
        placeholder="Go to file…"
        autoFocus
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          listRef.current?.scrollTo(0, 0);
        }}
      />
      <Command.List ref={listRef} className={paletteStyles.list}>
        {paths === null ? (
          <div className={styles.status}>
            {listing.isError
              ? "Couldn't list this workspace's files."
              : "Listing files…"}
          </div>
        ) : (
          <>
            <Command.Empty className={styles.status}>No matching files</Command.Empty>
            {matches.map((match) => (
              <Command.Item
                key={match.path}
                value={match.path}
                className={paletteStyles.item}
                onSelect={() => onPick(match.path)}
              >
                <span className={paletteStyles.icon}>
                  <FileCode size={14} />
                </span>
                <FileRow match={match} />
              </Command.Item>
            ))}
          </>
        )}
      </Command.List>
      {listing.data?.truncated && (
        <div className={styles.truncated}>
          Too many files to list them all; some are missing.
        </div>
      )}
    </Command>
  );
}

/** The file name, then its folder, dimmed; matched characters highlighted. */
function FileRow({ match }: { match: FileMatch }) {
  const { path, positions } = match;
  const nameStart = path.lastIndexOf("/") + 1;
  const hits = new Set(positions);
  const highlight = (from: number, to: number) => {
    const parts = [];
    for (let i = from; i < to; i++) {
      const ch = path[i];
      parts.push(
        hits.has(i) ? (
          <span key={i} className={styles.hit}>
            {ch}
          </span>
        ) : (
          ch
        ),
      );
    }
    return parts;
  };
  return (
    <>
      <span className={styles.name}>{highlight(nameStart, path.length)}</span>
      {nameStart > 0 && (
        <span className={styles.dir}>{highlight(0, nameStart - 1)}</span>
      )}
    </>
  );
}
