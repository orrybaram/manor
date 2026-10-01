import { ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../ipc-validate";
import { resolveSpawnCwd } from "../paths";
import { HostUnavailableError } from "../backend/host-view";
import { LOCAL_HOST_ID, type HostId } from "../backend/types";
import { errorMessage } from "../lib/errors";
import { isHomePath } from "../../src/lib/home-path";
import { attach, release } from "../pty-attachments";
import type { IpcDeps } from "./types";
import type {
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
} from "../../src/electron.d";

/**
 * Read git branch synchronously from a repo or worktree root, for this
 * machine's own checkout only. Its one caller (`main.ts`) reads
 * `process.cwd()` — Manor's own source tree — before `app.whenReady()`, so
 * before any `BackendRegistry` exists and always on this machine; it is
 * intentionally not routed through the backend (ADR-178 §3 concerns
 * *projects*' branches, read by `BranchWatcher`, not Manor's own repo).
 */
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
  if (isHomePath(cwd)) throw new Error("The Dashboard can't host panes");
  return resolveSpawnCwd(cwd);
}

/**
 * The host a new session should run on, as the renderer named it — the host
 * of the workspace its pane belongs to — or undefined when it didn't, so
 * `RoutedBackend` falls back to the host the cwd belongs to.
 */
function requestedHost(opts: PtyResetOptions | undefined): HostId | undefined {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== "object") throw new Error("opts must be an object");
  if (opts.hostId === undefined) return undefined;
  assertString(opts.hostId, "hostId");
  return opts.hostId;
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
  opts?: PtyCreateOptions,
): Promise<PtyCreateResult> {
  const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
  const hostId = requestedHost(opts);
  const agentKind = opts?.agentKind;
  const env: Record<string, string> | undefined = agentKind
    ? { MANOR_AGENT_KIND: agentKind }
    : undefined;
  try {
    const result = await deps.backend.pty.createOrAttachWith(
      paneId,
      resolvedCwd,
      cols,
      rows,
      { env, hostId },
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
      // The host the session actually runs on — not its project's
      // current host, which may have changed since (ADR-160). The
      // renderer badges a tab from this, so a pane that predates a
      // project move keeps its true host.
      hostId: result.hostId,
    };
  } catch (err) {
    const error = errorMessage(err);
    // A registered remote host that is not connected is not a broken
    // terminal (ADR-178 §6): the renderer shows the host's offline
    // banner and creates the pane once the host is back. A remote pty
    // call rejects with `HostUnavailableError` whenever its host is away
    // (ADR-183); "unknown" is a host nobody registered.
    if (err instanceof HostUnavailableError && err.status !== "unknown") {
      return { ok: false, reason: "host-unavailable", hostId: err.hostId, error };
    }
    console.error(`Failed to create/attach PTY for ${paneId}:`, err);
    return { ok: false, reason: "error", error };
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
  opts?: PtyResetOptions,
): Promise<{
  ok: boolean;
  snapshot?: string | null;
  prewarmed?: boolean;
  hostId?: string;
  error?: string;
}> {
  const { backend } = deps;
  const resolvedCwd = validatePtyArgs(paneId, cwd, cols, rows);
  const hostId = requestedHost(opts);
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

      const result = await backend.pty.createOrAttachWith(
        paneId, resolvedCwd, cols, rows, { hostId },
      );
      if (!result.snapshot) {
        return {
          ok: true,
          snapshot: null,
          prewarmed: false,
          hostId: result.hostId,
        };
      }

      // Reattached to old (dying) session — detach and retry.
      try { await backend.pty.detach(paneId); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch (err) {
    console.error(`Failed to reset PTY for ${paneId}:`, err);
    return {
      ok: false,
      error: errorMessage(err),
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
      opts?: PtyCreateOptions,
    ): Promise<PtyCreateResult> => {
      const result = await ptyCreate(deps, paneId, cwd, cols, rows, opts);
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
      opts?: PtyResetOptions,
    ) => {
      const result = await ptyReset(deps, paneId, cwd, cols, rows, opts);
      if (result.ok) attach(paneId, event.sender.id);
      return result;
    },
  );

  ipcMain.handle("pty:detach", (event, paneId: string) => {
    release(paneId, event.sender.id);
    return ptyDetach(deps, paneId);
  });

  // The renderer names the workspace's host alongside its cwd (ADR-183).
  ipcMain.handle(
    "pty:consumePrewarmed",
    (_event, cwd: string | null, hostId: string = LOCAL_HOST_ID) => {
      if (cwd !== null) assertString(cwd, "cwd");
      assertString(hostId, "hostId");
      if (isHomePath(cwd)) return null;
      return deps.prewarmManager?.consume(resolveSpawnCwd(cwd), hostId) ?? null;
    },
  );

  ipcMain.handle(
    "pty:updatePrewarmCwd",
    async (
      _event,
      cwd: string,
      hostId: string,
      agentCommand?: string | null,
      agentKind?: string | null,
    ) => {
      assertString(cwd, "cwd");
      assertString(hostId, "hostId");
      // The Dashboard hosts no panes; never warm a shell for it.
      if (isHomePath(cwd)) return;
      await deps.prewarmManager?.updateCwd(resolveSpawnCwd(cwd), hostId, agentCommand, agentKind);
    },
  );
}
