/**
 * The terminal (ADR-180 D8), as the `pty` namespace of the handler table.
 *
 * `create` and `reset` answer with who owns the winsize, and attach the
 * calling connection as a viewer once they succeed. Every caller comes
 * through here — a renderer window over `bridge:*` IPC and a paired device
 * over the socket — so this is the one place a pane gains a viewer, and
 * `resize` is a no-op for anyone who is not the one that owns it (ADR-180 D6,
 * `pty-attachments.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../../ipc-validate";
import { resolveSpawnCwd } from "../../paths";
import {
  attach,
  claim,
  ownerOf,
  reclaimOnInput,
  release,
  wouldOwn,
  type Viewer,
} from "../../pty-attachments";
import { HostUnavailableError } from "../../backend/host-view";
import { LOCAL_HOST_ID, type HostId } from "../../backend/types";
import { errorMessage } from "../../lib/errors";
import { isHomePath } from "../../../src/lib/home-path";
import type { HostDeps } from "../../ipc/types";
import type {
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
  PtyWinsize,
} from "../../../src/electron.d";
import { method, type Caller, type HandlerCtx } from "../method";

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

function validatePtyArgs(
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
): string {
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
function requestedHost(
  opts: PtyResetOptions | null | undefined,
): HostId | undefined {
  if (opts === undefined || opts === null) return undefined;
  if (typeof opts !== "object") throw new Error("opts must be an object");
  if (opts.hostId === undefined) return undefined;
  assertString(opts.hostId, "hostId");
  return opts.hostId;
}

/** The caller, as the viewer `pty-attachments.ts` holds a pane under. */
function asViewer(caller: Caller): Viewer {
  return { connectionId: caller.id, callerClass: caller.callerClass };
}

/** What a create-shaped call tells the caller about the winsize (D5). */
type WinsizeDecoration = Required<PtyWinsize>;

/**
 * The session's current grid, or null if the daemon has no opinion yet.
 *
 * Never throws: a caller that cannot be told the owner's size is better off
 * with the size it asked for than with a failed `pty.create`. Exported for
 * `server.ts`'s ownership-change push (D6), which needs the same "ask the
 * daemon, shrug on failure" grid lookup outside of a create call.
 */
export async function sessionGrid(
  deps: HostDeps,
  paneId: string,
): Promise<{ cols: number; rows: number } | null> {
  try {
    const snapshot = await deps.backend.pty.getSnapshot(paneId);
    if (!snapshot?.cols || !snapshot.rows) return null;
    return { cols: snapshot.cols, rows: snapshot.rows };
  } catch {
    return null;
  }
}

/**
 * Run a create-shaped call, tell the caller who owns the winsize, and attach
 * it as a viewer once the call succeeds (D5/D6).
 *
 * When someone who outranks this caller holds the pane, the caller's own
 * `cols×rows` is dropped before the call: `createOrAttach` resizes the
 * session before it snapshots it (see `terminal-host/client.ts`), so passing
 * a follower's grid through would resize the owner's pane as a side effect of
 * merely looking at it — the exact bug ADR-163/164/165 are about, arriving
 * through the one door marked "read". The answer carries the owner's grid,
 * which is what the follower renders.
 *
 * Who outranks whom is `pty-attachments.ts`'s rule: a caller is a follower
 * exactly when attaching would *not* make it the owner (`wouldOwn`), which for
 * a window on this machine is only when it already holds the pane and let
 * another viewer take it.
 */
async function createShaped<T extends { ok: boolean }>(
  ctx: HandlerCtx,
  paneId: string,
  cols: number,
  rows: number,
  run: (cols: number, rows: number) => Promise<T>,
): Promise<T | (T & WinsizeDecoration)> {
  const viewer = asViewer(ctx.caller);
  const follower = !wouldOwn(paneId, viewer);
  const owner = follower ? await sessionGrid(ctx.deps, paneId) : null;
  const grid = owner ?? { cols, rows };
  const result = await run(grid.cols, grid.rows);
  if (!result.ok) return result;
  attach(paneId, viewer);
  return {
    ...result,
    winsizeOwner: !follower,
    cols: grid.cols,
    rows: grid.rows,
  };
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
  deps: HostDeps,
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
 *
 * Not lost to a remote host that drops before the shell is ready, either
 * (ADR-178 §6): the command goes back on the queue for the pane's next
 * create, as long as the pane is still in a layout and nothing newer was
 * queued for it meanwhile — the server's form of the renderer requeue
 * (`shouldRequeuePaneCommand`) this queue replaced.
 */
async function deliverPendingCommand(
  deps: HostDeps,
  paneId: string,
  hostId: HostId,
): Promise<void> {
  const layoutStore = deps.layoutStore;
  const pending = layoutStore?.pendingCommands.take(paneId);
  if (!layoutStore || !pending) return;
  try {
    await deps.backend.pty.writeAfterReady(
      paneId,
      pending.submit ? pending.text + "\r" : pending.text,
    );
  } catch (err) {
    if (
      hostId !== LOCAL_HOST_ID &&
      layoutStore.locate({ paneId }) !== null
    ) {
      layoutStore.pendingCommands.requeue(paneId, pending);
      return;
    }
    console.error(
      `[pty] failed to send the ${pending.kind} command queued for ${paneId}:`,
      err,
    );
  }
}

/**
 * Open (or reattach to) a pane's session.
 *
 * A renderer window and a paired device go through the same `assert*`
 * validation — a browser on the far end of a tunnel is not more trusted than
 * a renderer, it is less.
 */
export function ptyCreate(
  ctx: HandlerCtx,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyCreateOptions | null,
): Promise<PtyCreateResult> {
  return createShaped(ctx, paneId, cols, rows, (c, r) =>
    createSession(ctx.deps, paneId, cwd, c, r, opts ?? undefined),
  );
}

async function createSession(
  deps: HostDeps,
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
    // an agent, `POST /agents` — has its line waiting on the server. This is
    // the moment it has a shell to be typed into. A command put back after
    // its remote host dropped is typed on a reattach too: the session it was
    // meant for may have survived on the host, without it.
    const fresh = isFreshSession(deps, paneId, result.snapshot !== null);
    if (fresh || deps.layoutStore?.pendingCommands.isRequeued(paneId)) {
      await deliverPendingCommand(deps, paneId, result.hostId);
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

export function ptyWrite(ctx: HandlerCtx, paneId: string, data: string): void {
  assertString(paneId, "paneId");
  assertString(data, "data");
  // Typing, not xterm answering a query: replies to DA/DSR/focus reports
  // start with ESC and are sent without anyone touching a key.
  if (!data.startsWith("\x1b")) reclaimOnInput(paneId, asViewer(ctx.caller));
  ctx.deps.backend.pty.write(paneId, data);
}

/**
 * Take this pane's winsize: the viewer stops following and fits the session
 * to itself (`pty-attachments.ts`, `claim`). Nothing is resized here — the
 * ownership push tells this viewer it owns the grid now, and its own fit
 * sends the resize, through `ptyResize`, as any owner's does.
 */
export function ptyClaimWinsize(ctx: HandlerCtx, paneId: string): boolean {
  assertString(paneId, "paneId");
  return claim(paneId, asViewer(ctx.caller));
}

/**
 * A follower asking for a size is not an error, and it is not a resize.
 *
 * It is answered rather than refused because refusing is a rejected promise
 * on every layout tick, which `useTerminalResize` would log; and it is
 * dropped rather than forwarded because it is not this caller's grid to move
 * (D6) — it belongs to another viewer, which may be a second window of the
 * desktop as readily as a browser. A caller that owns the pane's winsize
 * resizes normally.
 */
export async function ptyResize(
  ctx: HandlerCtx,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const owner = ownerOf(paneId);
  if (owner && owner.connectionId !== ctx.caller.id) return;
  assertString(paneId, "paneId");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
  try {
    await ctx.deps.backend.pty.resize(paneId, cols, rows);
  } catch {
    // ignore resize errors
  }
}

export async function ptyClose(ctx: HandlerCtx, paneId: string): Promise<void> {
  release(paneId, asViewer(ctx.caller));
  assertString(paneId, "paneId");
  try {
    await ctx.deps.backend.pty.kill(paneId);
  } catch {
    // ignore close errors
  }
}

/**
 * Stop *this* viewer watching — and drop the daemon stream only if it was
 * the last one.
 *
 * The Manor server holds exactly one stream subscription per session for
 * every renderer it serves (`terminal-host/client.ts`'s `wanted` set), and
 * detaching unsubscribes it. Called unconditionally, one viewer's detach was
 * everyone's: `useTerminalConnection` detaches on every effect cleanup, so a
 * browser that merely switched away from a workspace it shared with the desk
 * cut the desk's terminal off mid-stream.
 *
 * A socket that drops without detaching releases its viewers in
 * `BridgeServer.drop` and leaves the stream subscribed — output with no
 * subscriber is discarded at the fan-out, which costs a little and loses
 * nothing, and the next `pty.create` reuses the live subscription.
 */
export async function ptyDetach(
  ctx: HandlerCtx,
  paneId: string,
): Promise<void> {
  release(paneId, asViewer(ctx.caller));
  if (ownerOf(paneId)) return;
  assertString(paneId, "paneId");
  try {
    await ctx.deps.backend.pty.detach(paneId);
  } catch {
    // ignore detach errors
  }
}

/**
 * Kill this pane's session and spawn a fresh one in its place.
 *
 * Create-shaped — it answers with a snapshot and leaves the caller attached —
 * so it is decorated with the same winsize ownership `pty.create` gets (D5).
 */
export function ptyReset(
  ctx: HandlerCtx,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyResetOptions | null,
): Promise<PtyResetResult> {
  return createShaped(ctx, paneId, cols, rows, (c, r) =>
    resetSession(ctx.deps, paneId, cwd, c, r, opts ?? undefined),
  );
}

/** What `pty.reset` answers with (and the winsize half, `PtyWinsize`). */
export type PtyResetResult = {
  ok: boolean;
  snapshot?: string | null;
  error?: string;
  prewarmed?: boolean;
  /** The host the fresh session runs on (ADR-160). */
  hostId?: string;
} & PtyWinsize;

async function resetSession(
  deps: HostDeps,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyResetOptions,
): Promise<PtyResetResult> {
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

      try {
        await backend.pty.disposeDead();
      } catch {
        /* ignore */
      }

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
      try {
        await backend.pty.detach(paneId);
      } catch {
        /* ignore */
      }
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
 */
export function ptyConsumePrewarmed(
  ctx: HandlerCtx,
  cwd: string | null,
  hostId?: string | null,
): { paneId: string; commandInjected: boolean } | null {
  const host = hostId ?? LOCAL_HOST_ID;
  if (cwd !== null) assertString(cwd, "cwd");
  assertString(host, "hostId");
  if (isHomePath(cwd)) return null;
  return ctx.deps.prewarmManager?.consume(resolveSpawnCwd(cwd), host) ?? null;
}

/** Point the prewarmed session at a different workspace, respawning it. */
export async function ptyUpdatePrewarmCwd(
  ctx: HandlerCtx,
  cwd: string,
  hostId: string,
  agentCommand?: string | null,
  agentKind?: string | null,
): Promise<void> {
  assertString(cwd, "cwd");
  assertString(hostId, "hostId");
  // The Dashboard hosts no panes; never warm a shell for it.
  if (isHomePath(cwd)) return;
  await ctx.deps.prewarmManager?.updateCwd(
    resolveSpawnCwd(cwd),
    hostId,
    agentCommand,
    agentKind,
  );
}

export const pty = {
  // Starting or ending a session is audited; `write` is the keyboard, and a
  // line per keystroke is a keylogger (ADR-161). `resize` and `detach` are
  // what a viewer does to its own view.
  create: method(ptyCreate, { mutating: true }),
  reset: method(ptyReset, { mutating: true }),
  write: method(ptyWrite),
  resize: method(ptyResize),
  claimWinsize: method(ptyClaimWinsize),
  close: method(ptyClose, { mutating: true }),
  detach: method(ptyDetach),
  // One prewarmed session per host, and its cwd tracks the primary window's
  // workspace: a device adopting it gets a shell somewhere else, and a device
  // moving it moves the desktop's out from under it.
  consumePrewarmed: method(ptyConsumePrewarmed, { localOnly: true }),
  updatePrewarmCwd: method(ptyUpdatePrewarmCwd, { localOnly: true }),
};
