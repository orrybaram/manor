import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../ipc-validate";
import { resolveSpawnCwd } from "../paths";
import { attach, release } from "../pty-attachments";
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
  return resolveSpawnCwd(cwd);
}

/**
 * The bodies below are lifted out of their `ipcMain.handle` wrappers so the
 * ADR-178 WebSocket bridge can call exactly the same code the desktop
 * renderer reaches, rather than dispatching reflectively into `ipcMain`'s
 * private handler map. Both callers go through the same `assert*` validation,
 * because a browser on the far end of a tunnel is not more trusted than a
 * renderer — it is less.
 */
export async function ptyCreate(
  deps: IpcDeps,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  agentKind?: string | null,
): Promise<{
  ok: boolean;
  snapshot?: string | null;
  snapshotSeq?: number;
  prewarmed?: boolean;
  error?: string;
}> {
  const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
  const env: Record<string, string> | undefined = agentKind
    ? { MANOR_AGENT_KIND: agentKind }
    : undefined;
  try {
    const result = await deps.backend.pty.createOrAttach(
      paneId,
      resolvedCwd,
      cols,
      rows,
      undefined,
      env,
    );
    // Return snapshot to the renderer so it can write it exactly once,
    // avoiding duplicate writes from StrictMode double-mounting.
    // A non-null snapshot means the session already existed (prewarmed).
    return {
      ok: true,
      snapshot: result.snapshot?.screenAnsi || null,
      // Stream position the snapshot reflects — the renderer drops queued
      // output at or below it (ADR-159). Absent when there is no snapshot,
      // or when an older daemon does not report one.
      snapshotSeq: result.snapshot?.seq,
      prewarmed: result.snapshot !== null,
    };
  } catch (err) {
    console.error(`Failed to create/attach PTY for ${paneId}:`, err);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function ptyWrite(deps: IpcDeps, paneId: string, data: string): void {
  assertString(paneId, "paneId");
  assertString(data, "data");
  deps.backend.pty.write(paneId, data);
}

export async function ptyResize(
  deps: IpcDeps,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  assertString(paneId, "paneId");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  try {
    await deps.backend.pty.resize(paneId, cols, rows);
  } catch {
    // ignore resize errors
  }
}

export async function ptyClose(deps: IpcDeps, paneId: string): Promise<void> {
  assertString(paneId, "paneId");
  try {
    await deps.backend.pty.kill(paneId);
  } catch {
    // ignore close errors
  }
}

export async function ptyDetach(deps: IpcDeps, paneId: string): Promise<void> {
  assertString(paneId, "paneId");
  try {
    await deps.backend.pty.detach(paneId);
  } catch {
    // ignore detach errors
  }
}

/**
 * Kill this pane's session and spawn a fresh one in its place.
 *
 * Lifted out of its `ipcMain.handle` wrapper for the reason the functions above
 * were: it is create-shaped — it answers with a snapshot and leaves the caller
 * attached — so the ADR-178 bridge has to reach the same code, and decorate it
 * with the same winsize ownership `pty.create` gets (D5).
 */
export async function ptyReset(
  deps: IpcDeps,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
): Promise<{
  ok: boolean;
  snapshot?: string | null;
  prewarmed?: boolean;
  error?: string;
}> {
  const { backend } = deps;
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
}

export function register(deps: IpcDeps): void {
  // Create, reset, close and detach are the desktop's four statements about
  // whether it has a pane mounted, and that is the whole of the winsize
  // ownership question the bridge asks (ADR-178 D5). The bookkeeping lives in
  // these wrappers rather than in the lifted functions above because a browser
  // reaching the same code through the bridge is a *follower*: it must not be
  // able to claim the winsize by asking for a session.
  ipcMain.handle(
    "pty:create",
    async (
      event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
      agentKind?: string | null,
    ) => {
      const result = await ptyCreate(deps, paneId, cwd, cols, rows, agentKind);
      if (result.ok) attach(paneId, event.sender.id);
      return result;
    },
  );

  ipcMain.handle("pty:write", (_event, paneId: string, data: string) => {
    ptyWrite(deps, paneId, data);
  });

  ipcMain.handle(
    "pty:resize",
    (_event, paneId: string, cols: number, rows: number) =>
      ptyResize(deps, paneId, cols, rows),
  );

  ipcMain.handle("pty:close", (event, paneId: string) => {
    release(paneId, event.sender.id);
    return ptyClose(deps, paneId);
  });

  ipcMain.handle(
    "pty:reset",
    async (
      event,
      paneId: string,
      cwd: string | null,
      cols: number,
      rows: number,
    ) => {
      const result = await ptyReset(deps, paneId, cwd, cols, rows);
      if (result.ok) attach(paneId, event.sender.id);
      return result;
    },
  );

  ipcMain.handle("pty:detach", (event, paneId: string) => {
    release(paneId, event.sender.id);
    return ptyDetach(deps, paneId);
  });

  ipcMain.handle("pty:consumePrewarmed", () => {
    return deps.prewarmManager?.consume() ?? null;
  });

  ipcMain.handle("pty:updatePrewarmCwd", async (_event, cwd: string, agentCommand?: string | null, agentKind?: string | null) => {
    assertString(cwd, "cwd");
    await deps.prewarmManager?.updateCwd(resolveSpawnCwd(cwd), agentCommand, agentKind);
  });
}
