import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../ipc-validate";
import type { IpcDeps } from "./types";

/** Read git branch synchronously from a repo or worktree root. */
export function readBranchSync(repoPath: string): string | null {
  try {
    const gitPath = path.join(repoPath, ".git");
    const stat = fs.statSync(gitPath);

    let headPath: string;
    if (stat.isDirectory()) {
      headPath = path.join(gitPath, "HEAD");
    } else {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = fs.readFileSync(gitPath, "utf-8").trim();
      const m = content.match(/^gitdir:\s*(.+)$/);
      if (!m) return null;
      const gitdir = path.isAbsolute(m[1])
        ? m[1]
        : path.resolve(repoPath, m[1]);
      headPath = path.join(gitdir, "HEAD");
    }

    const head = fs.readFileSync(headPath, "utf-8").trim();
    const refMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}

function validatePtyArgs(paneId: string, cwd: string | null, cols: number, rows: number): string {
  assertString(paneId, "paneId");
  if (cwd !== null) assertString(cwd, "cwd");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  return cwd || process.env.HOME || "/";
}

export function register(deps: IpcDeps): void {
  const { backend } = deps;

  ipcMain.handle(
    "pty:create",
    async (
      _event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
    ) => {
      const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
      try {
        const result = await backend.pty.createOrAttach(
          paneId,
          resolvedCwd,
          cols,
          rows,
        );
        // Return snapshot to the renderer so it can write it exactly once,
        // avoiding duplicate writes from StrictMode double-mounting.
        // A non-null snapshot means the session already existed (prewarmed).
        return {
          ok: true,
          snapshot: result.snapshot?.screenAnsi || null,
          prewarmed: result.snapshot !== null,
        };
      } catch (err) {
        console.error(`Failed to create/attach PTY for ${paneId}:`, err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("pty:write", (_event, paneId: string, data: string) => {
    assertString(paneId, "paneId");
    assertString(data, "data");
    backend.pty.write(paneId, data);
  });

  ipcMain.handle(
    "pty:resize",
    async (_event, paneId: string, cols: number, rows: number) => {
      assertString(paneId, "paneId");
      assertPositiveInt(cols, "cols");
      assertPositiveInt(rows, "rows");
      try {
        await backend.pty.resize(paneId, cols, rows);
      } catch {
        // ignore resize errors
      }
    },
  );

  ipcMain.handle("pty:close", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    try {
      await backend.pty.kill(paneId);
    } catch {
      // ignore close errors
    }
  });

  ipcMain.handle(
    "pty:reset",
    async (
      _event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
    ) => {
      const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
      try {
        try {
          await backend.pty.kill(paneId);
        } catch {
          // Session may not exist.
        }

        // The daemon may still have the old session in its map if the
        // shell hasn't fully exited yet. Retry until we get a fresh
        // session (snapshot === null).
        const deadline = Date.now() + 3_000;
        while (true) {
          if (Date.now() >= deadline) {
            return {
              ok: false,
              error: "Reset timed out — old session still active",
            };
          }

          try { await backend.pty.disposeDead(); } catch { /* ignore */ }

          const result = await backend.pty.createOrAttach(
            paneId, resolvedCwd, cols, rows,
          );
          if (!result.snapshot) {
            return { ok: true, snapshot: null, prewarmed: false };
          }

          // Reattached to old (dying) session — detach and retry.
          try { await backend.pty.detach(paneId); } catch { /* ignore */ }
          await new Promise((r) => setTimeout(r, 100));
        }
      } catch (err) {
        console.error(`Failed to reset PTY for ${paneId}:`, err);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("pty:detach", async (_event, paneId: string) => {
    assertString(paneId, "paneId");
    try {
      await backend.pty.detach(paneId);
    } catch {
      // ignore detach errors
    }
  });

  ipcMain.handle("pty:consumePrewarmed", () => {
    return deps.prewarmManager?.consume() ?? null;
  });

  ipcMain.handle("pty:updatePrewarmCwd", async (_event, cwd: string, agentCommand?: string | null) => {
    assertString(cwd, "cwd");
    await deps.prewarmManager?.updateCwd(cwd, agentCommand);
  });
}
