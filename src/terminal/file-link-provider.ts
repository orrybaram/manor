import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";
import { openInEditor } from "../lib/editor";
import { useAppStore } from "../store/app-store";

/**
 * Matches file paths in terminal output, including optional :line:col suffixes.
 *
 * Captures:
 *   [1] the file path
 *   [2] optional line number
 *   [3] optional column number
 *
 * Supported patterns:
 *   /absolute/path/file.ts
 *   ./relative/file.tsx:42
 *   ../parent/file.js:10:5
 *   src/components/App.tsx:100:15
 */
const FILE_PATH_RE =
  /((?:\.{0,2}\/)?[\w@.+\-][\w@.+\-/]*\.\w+)(?::(\d+)(?::(\d+))?)?/g;

export function createFileLinkProvider(
  terminal: Terminal,
  paneId: string,
  fallbackCwd: string,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback) {
      const line = getLineText(terminal, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const cwd =
        useAppStore.getState().paneCwd[paneId] || fallbackCwd;

      const candidates: Array<{
        path: string;
        startX: number;
        endX: number;
        fullMatch: string;
      }> = [];

      FILE_PATH_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = FILE_PATH_RE.exec(line)) !== null) {
        const filePath = match[1];
        // Skip things that are clearly not file paths
        if (filePath.startsWith("http") || filePath.startsWith("//")) continue;

        candidates.push({
          path: filePath,
          startX: match.index + 1, // 1-based
          endX: match.index + match[0].length, // 1-based, inclusive
          fullMatch: match[0],
        });
      }

      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      // Validate all candidates concurrently
      Promise.all(
        candidates.map(async (c) => {
          const resolved = await window.electronAPI.shell.resolveFilePath(
            c.path,
            cwd,
          );
          return resolved ? { ...c, resolved } : null;
        }),
      ).then((results) => {
        const links: ILink[] = [];
        for (const r of results) {
          if (!r) continue;
          links.push({
            range: {
              start: { x: r.startX, y: bufferLineNumber },
              end: { x: r.endX, y: bufferLineNumber },
            },
            text: r.fullMatch,
            decorations: { pointerCursor: true, underline: true },
            activate: () => {
              openInEditor(r.resolved);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}

function getLineText(terminal: Terminal, lineNumber: number): string {
  const buffer = terminal.buffer.active;
  const line = buffer.getLine(lineNumber - 1);
  return line ? line.translateToString(true) : "";
}
