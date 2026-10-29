import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";
import { openInEditor } from "../lib/editor";
import { useAppStore } from "../store/app-store";
import type { FilesWorkspace } from "../components/workspace-panes/FilePane/open-file-watches";
import { matchFilePaths, workspaceCandidates, type FilePathMatch } from "./file-path-links";
import { workspaceFileIndex } from "./workspace-file-index";
import { LOCAL_HOST_ID, normalizeHostId } from "../lib/workspace-key";
import type { TerminalFileLink } from "./link-hover";

type FileLinkOptions = {
  terminal: Terminal;
  paneId: string;
  /** The cwd the pane was mounted with, until the shell reports its own. */
  fallbackCwd: string;
  /** The terminal's workspace, whose files are links; null when it has none. */
  workspace: FilesWorkspace | null;
  /** A workspace file under the pointer, for the context menu. */
  hover: (link: TerminalFileLink) => void;
  leave: () => void;
  /** ⌘/Ctrl-click on a workspace file. */
  open: (link: TerminalFileLink) => void;
};

/** An extension: what the editor fallback (outside the workspace) needs. */
const HAS_EXTENSION = /\.\w+$/;

/**
 * Links for the file paths printed in a terminal.
 *
 * A path that is a file of the terminal's workspace, by the workspace's own
 * listing (`workspaceFileIndex`, one `files.list` kept per workspace), is a
 * file pane link: ⌘/Ctrl-click opens it beside the terminal, and right-click
 * offers it in the context menu. Relative paths resolve against the shell's
 * cwd, then the workspace root while the cwd is in the workspace. Any other
 * path that exists on this machine still ⌘/Ctrl-clicks into the external
 * editor, as before; not in a workspace on another host, whose paths name
 * that host's files, not this machine's.
 */
export function createFileLinkProvider(opts: FileLinkOptions): ILinkProvider {
  const { terminal, paneId, fallbackCwd, workspace } = opts;
  const onAnotherHost = workspace !== null && normalizeHostId(workspace.hostId) !== LOCAL_HOST_ID;
  return {
    provideLinks(bufferLineNumber: number, callback) {
      const line = getLineText(terminal, bufferLineNumber);
      const matches = line ? matchFilePaths(line) : [];
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const cwd = useAppStore.getState().paneCwd[paneId] || fallbackCwd;
      const range = (m: FilePathMatch) => ({
        start: { x: m.start + 1, y: bufferLineNumber },
        end: { x: m.end, y: bufferLineNumber },
      });

      const inWorkspace = async (m: FilePathMatch): Promise<ILink | null> => {
        if (!workspace) return null;
        const path = await workspaceFileIndex.find(
          workspace,
          workspaceCandidates(m.path, cwd, workspace.path),
        );
        if (path === null) return null;
        const target: TerminalFileLink = {
          kind: "file",
          path,
          ...(m.line ? { line: m.line } : {}),
          ...(m.col ? { col: m.col } : {}),
        };
        return {
          range: range(m),
          text: line.slice(m.start, m.end),
          decorations: { pointerCursor: true, underline: true },
          hover: () => opts.hover(target),
          leave: () => opts.leave(),
          // xterm activates links on any plain click, so without a modifier
          // check, clicking into the terminal to focus it would open a pane.
          activate: (event) => {
            if (!event.metaKey && !event.ctrlKey) return;
            opts.open(target);
          },
        };
      };

      const onThisMachine = async (m: FilePathMatch): Promise<ILink | null> => {
        if (onAnotherHost || !HAS_EXTENSION.test(m.path)) return null;
        const resolved = await window.electronAPI.shell.resolveFilePath(m.path, cwd);
        if (!resolved) return null;
        return {
          range: range(m),
          text: line.slice(m.start, m.end),
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            if (!event.metaKey && !event.ctrlKey) return;
            openInEditor(resolved);
          },
        };
      };

      void Promise.all(
        matches.map(async (m) => {
          try {
            return (await inWorkspace(m)) ?? (await onThisMachine(m));
          } catch {
            return null;
          }
        }),
      ).then((links) => {
        const found = links.filter((l): l is ILink => l !== null);
        callback(found.length > 0 ? found : undefined);
      });
    },
  };
}

function getLineText(terminal: Terminal, lineNumber: number): string {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(lineNumber - 1);
  return line ? line.translateToString(true) : "";
}
