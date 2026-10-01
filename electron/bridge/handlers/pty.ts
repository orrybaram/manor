/**
 * The terminal, as plain functions over `IpcDeps` (ADR-180 D8).
 *
 * There is no `register()` here any more, and this is the first module to
 * lose one: `pty` crossed onto the handler table in ADR-180 ticket 5, so the
 * six `ipcMain.handle("pty:*")` wrappers that used to sit at the bottom of
 * this file are gone and `electron/bridge/handlers.ts` calls these functions
 * directly, for a renderer window and a paired device alike. What is left is
 * the implementation — the same `assert*` validation, the same daemon calls,
 * one caller fewer to keep in step.
 *
 * Winsize ownership is *not* decided here. The wrappers used to attach and
 * release viewers around these calls (`attach(paneId, event.sender.id)`),
 * which is why they had to exist at all; the table's entries do it now, with
 * the connection that asked (ADR-180 D6, `pty-attachments.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../../ipc-validate";
import { resolveSpawnCwd } from "../../paths";
import { HostUnavailableError } from "../../backend/host-view";
import { LOCAL_HOST_ID, type HostId } from "../../backend/types";
import { errorMessage } from "../../lib/errors";
import { isHomePath } from "../../../src/lib/home-path";
import type { IpcDeps } from "../../ipc/types";
import type {
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
} from "../../../src/electron.d";

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
 * Whether this create is the one that brought the pane's shell into being.
 *
 * Two ways for that to be true, and the second is not obvious: a session the
 * prewarm manager warmed in the background already exists when the pane that
 * adopts it is created, so it reports a snapshot like any warm reattach. The
 * manager knows which pane it just handed out and says so once
 * (`claimAdopted`), which keeps the *second* viewer of that same pane a
 * reattach — the thing this predicate exists to exclude.
 */
function isFreshSession(
  deps: IpcDeps,
  paneId: string,
  hadSnapshot: boolean,
): boolean {
  const adopted = deps.prewarmManager?.claimAdopted(paneId) ?? false;
  return !hadSnapshot || adopted;
}

/**
 * Type the pane's pending command, once, when its shell reaches a prompt.
 *
 * `writeAfterReady` rather than a plain write because the session was spawned
 * a moment ago and its line editor may not have initialised: the daemon holds
 * the bytes until the shell's first output. The trailing `\r` is what an Enter
 * keypress sends — `\n` is not reliably `accept-line` under zsh's ZLE. Text
 * queued with `submit: false` (a fix-it command the user reviews, ADR-183)
 * is typed without it.
 *
 * Never fatal to the create: a pane that opened without running its command is
 * a worse outcome than a pane that never opened, but only slightly, and the
 * caller has already got its session.
 */
async function deliverPendingCommand(
  deps: IpcDeps,
  paneId: string,
): Promise<void> {
  const pending = deps.layoutStore?.pendingCommands.take(paneId);
  if (!pending) return;
  try {
    await deps.backend.pty.writeAfterReady(
      paneId,
      pending.submit ? pending.text + "\r" : pending.text,
    );
  } catch (err) {
    console.error(
      `[pty] failed to send the ${pending.kind} command queued for ${paneId}:`,
      err,
    );
  }
}

/**
 * The bodies below were lifted out of `ipcMain.handle` wrappers so the
 * ADR-178 bridge could call exactly the same code the desktop renderer
 * reached, rather than dispatching reflectively into `ipcMain`'s private
 * handler map. ADR-180 ticket 5 removed the wrappers entirely: both callers
 * now arrive through the handler table, and both go through the same
 * `assert*` validation — because a browser on the far end of a tunnel is not
 * more trusted than a renderer, it is less, and a renderer is not more
 * trusted than it was when its arguments went unchecked.
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
    // A pane opened "with a command" — `POST /tabs { command }`, a split with
    // an agent, `POST /agents` — has its line waiting on the server (ADR-179
    // ticket 11). This is the moment it has a shell to be typed into.
    if (isFreshSession(deps, paneId, result.snapshot !== null)) {
      await deliverPendingCommand(deps, paneId);
    }

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

/**
 * Hand out the background-warmed session, if one is ready (ADR-083) and it
 * sits where the caller is asking for one — the renderer names the
 * workspace's host alongside its cwd (ADR-183).
 *
 * `local` only (ADR-180 D4): a prewarmed session belongs to the window that
 * asked for one. Its cwd tracks the *primary* window's active workspace, so
 * a caller looking at something else — a popout, or a phone on the bridge —
 * would adopt a shell sitting in the wrong directory.
 */
export function ptyConsumePrewarmed(
  deps: IpcDeps,
  cwd: string | null,
  hostId: string = LOCAL_HOST_ID,
): { paneId: string; commandInjected: boolean } | null {
  if (cwd !== null) assertString(cwd, "cwd");
  assertString(hostId, "hostId");
  if (isHomePath(cwd)) return null;
  return deps.prewarmManager?.consume(resolveSpawnCwd(cwd), hostId) ?? null;
}

/**
 * Point the prewarmed session at a different workspace, respawning it.
 *
 * `local` only, for the reason above: there is one prewarmed session per
 * host, and it follows the window at the machine.
 */
export async function ptyUpdatePrewarmCwd(
  deps: IpcDeps,
  cwd: string,
  hostId: string,
  agentCommand?: string | null,
  agentKind?: string | null,
): Promise<void> {
  assertString(cwd, "cwd");
  assertString(hostId, "hostId");
  // The Dashboard hosts no panes; never warm a shell for it.
  if (isHomePath(cwd)) return;
  await deps.prewarmManager?.updateCwd(
    resolveSpawnCwd(cwd),
    hostId,
    agentCommand,
    agentKind,
  );
}
