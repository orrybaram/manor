/**
 * The terminal, as the `pty` namespace of the handler table.
 *
 * `create`, `attach` and `reset` answer with who owns the winsize, and
 * attach the calling connection as a viewer once they succeed. Every caller
 * comes through here — a renderer window over `bridge:*` IPC and a paired device
 * over the socket — so this is the one place a pane gains a viewer, and
 * `resize` is a no-op for anyone who is not the one that owns it
 * (`pty-attachments.ts`).
 */

import fs from "node:fs";
import path from "node:path";
import { assertString, assertPositiveInt } from "../../ipc-validate";
import {
  attach,
  claim,
  isHeld,
  ownerOf,
  reclaimOnInput,
  release,
  wouldOwn,
  type Viewer,
} from "../../pty-attachments";
import { LOCAL_HOST_ID, type PtyBackend } from "../../backend/types";
import type { TerminalSnapshot } from "../../terminal-host/types";
import { errorMessage } from "../../lib/errors";
import { isHomePath } from "../../../src/lib/home-path";
import { resolveSpawnCwd } from "../../paths";
import type { ServerDeps } from "../../ipc/types";
import {
  requestedHost,
  spawnPane,
  toPtyFailure,
  validatePtyArgs,
  type SpawnPaneDeps,
} from "../../server/spawn-pane";
import type {
  PtyAttachOptions,
  PtyAttachResult,
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
  PtyWinsize,
} from "../../../src/electron.d";
import { byPane, method, type Caller, type HandlerCtx } from "../method";
import { sessionGrid, type BridgeServerDeps } from "../server";

/**
 * Read git branch synchronously from a repo or worktree root, for this
 * machine's own checkout only. Its one caller (`main.ts`) reads
 * `process.cwd()` — Manor's own source tree — before `app.whenReady()`, so
 * before any `BackendRegistry` exists and always on this machine; it is
 * intentionally not routed through the backend (backend routing concerns
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

/**
 * What a viewer's own calls on a session read — write, resize, detach — and
 * nothing else. `ServerDeps` has it, and so does the host
 * server's `HostServerDeps`, which reuses these handlers as they are.
 */
export interface PtyViewerDeps {
  backend: {
    pty: Pick<PtyBackend, "write" | "resize" | "detach" | "getSnapshot">;
  };
}

/**
 * The caller, as the viewer `pty-attachments.ts` holds a pane under. Who
 * outranks whom — only a desk window (`local`, or a desktop viewer stream on
 * a host server) does — is the registry's rule, not decided here.
 */
function asViewer(caller: Caller): Viewer {
  return {
    connectionId: caller.id,
    callerClass: caller.callerClass,
    ...(caller.viewer !== undefined && { viewer: caller.viewer }),
  };
}

/** What a create-shaped call tells the caller about the winsize. */
type WinsizeDecoration = Required<PtyWinsize>;

/**
 * Run a create-shaped call, tell the caller who owns the winsize, and attach
 * it as a viewer once the call succeeds.
 *
 * When someone who outranks this caller holds the pane, the caller's own
 * `cols×rows` is dropped before the call: `createOrAttach` resizes the
 * session before it snapshots it (see `terminal-host/client.ts`), so passing
 * a follower's grid through would resize the owner's pane as a side effect of
 * merely looking at it — the long-running winsize bug, arriving
 * through the one door marked "read". The answer carries the owner's grid,
 * which is what the follower renders.
 *
 * A host server's daemon-reported attach count reaches here as
 * the registry's foreign hold, set before the call: nobody follows anything
 * but the registry.
 *
 * Who outranks whom is `pty-attachments.ts`'s rule: a caller is a follower
 * exactly when attaching would *not* make it the owner (`wouldOwn`), which for
 * a window on this machine is only when it already holds the pane and let
 * another viewer take it.
 */
export async function createShaped<T extends { ok: boolean }>(
  ctx: HandlerCtx<BridgeServerDeps>,
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
 * Open (or reattach to) a pane's session.
 *
 * A renderer window and a paired device go through the same `assert*`
 * validation — a browser on the far end of the relay is not more trusted than
 * a renderer, it is less.
 *
 * Reads only what spawning does (`SpawnPaneDeps`), so a host server — which
 * has no prewarm — runs it as it is.
 */
export function ptyCreate(
  ctx: HandlerCtx<SpawnPaneDeps & BridgeServerDeps>,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyCreateOptions | null,
): Promise<PtyCreateResult> {
  // The same spawn the server's own launches use: a pane the
  // server already started is attached here, its command not typed again.
  // A remote pane on an adopted host never gets here: its create is that
  // host's server's (`HostRouting`).
  return createShaped(ctx, paneId, cols, rows, (c, r) =>
    spawnPane(ctx.deps, paneId, {
      cwd,
      cols: c,
      rows: r,
      hostId: requestedHost(opts),
      agentKind: opts?.agentKind,
      ...(opts?.wake === false && { wake: false }),
    }),
  );
}

/**
 * Re-attach a viewer to a pane whose session must already be running:
 * what a viewer resyncing after its connection dropped asks for.
 *
 * Unlike `pty.create` it never spawns — a session whose shell exited while
 * the viewer was away answers `exited`, and the viewer does what it would
 * have done with the `exit` it missed — and it makes no bid for the winsize.
 * The session is not resized, and the viewer attaches as a returning one, so
 * whoever attached meanwhile keeps the grid. The answer carries the session's
 * own grid, which is the owner's.
 */
export async function ptyAttach(
  ctx: HandlerCtx<ServerDeps>,
  paneId: string,
  opts?: PtyAttachOptions | null,
): Promise<PtyAttachResult> {
  assertString(paneId, "paneId");
  const { deps } = ctx;
  const { sessions } = deps.backendRegistry;
  try {
    // A restored pane's first attach leaves a sleeping host asleep.
    const snapshot = await (opts?.wake === false
      ? deps.backend.pty.attachExisting(paneId, { wake: false })
      : deps.backend.pty.attachExisting(paneId));
    if (!snapshot) {
      return {
        ok: false,
        reason: sessions.isRecoverableLoss(paneId) ? "lost" : "exited",
      };
    }
    // Where `RoutedBackend` sent the attach.
    const hostId = sessions.ownerOf(paneId) ?? LOCAL_HOST_ID;
    return attachReturning(ctx.caller, paneId, snapshot, hostId);
  } catch (err) {
    return toPtyFailure(err, paneId);
  }
}

/**
 * The caller back on a running session, as a returning viewer: no bid for
 * the winsize, and the session's own grid — the owner's — in the answer.
 * `pty.attach`'s success, here and on a host server.
 */
export function attachReturning(
  caller: Caller,
  paneId: string,
  snapshot: TerminalSnapshot,
  hostId: string,
): PtyAttachResult {
  const viewer = asViewer(caller);
  attach(paneId, viewer, { as: "returning" });
  return {
    ok: true,
    hostId,
    snapshot: snapshot.screenAnsi || null,
    snapshotSeq: snapshot.seq,
    winsizeOwner: ownerOf(paneId)?.connectionId === viewer.connectionId,
    cols: snapshot.cols,
    rows: snapshot.rows,
  };
}

export function ptyWrite(
  ctx: HandlerCtx<PtyViewerDeps>,
  paneId: string,
  data: string,
): void {
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
export function ptyClaimWinsize(
  ctx: HandlerCtx<PtyViewerDeps>,
  paneId: string,
): boolean {
  assertString(paneId, "paneId");
  return claim(paneId, asViewer(ctx.caller));
}

/**
 * A follower asking for a size is not an error, and it is not a resize.
 *
 * It is answered rather than refused because refusing is a rejected promise
 * on every layout tick, which `useTerminalResize` would log; and it is
 * dropped rather than forwarded because it is not this caller's grid to move —
 * it belongs to another viewer, which may be a second window of the
 * desktop as readily as a browser. A caller that owns the pane's winsize
 * resizes normally.
 */
export async function ptyResize(
  ctx: HandlerCtx<PtyViewerDeps>,
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

/**
 * What ending or replacing a session reads: the backend alone, so a host
 * server's table answers both as well.
 */
type PtySessionDeps = Pick<ServerDeps, "backend">;

export async function ptyClose(
  ctx: HandlerCtx<PtySessionDeps>,
  paneId: string,
): Promise<void> {
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
  ctx: HandlerCtx<PtyViewerDeps>,
  paneId: string,
): Promise<void> {
  release(paneId, asViewer(ctx.caller));
  if (isHeld(paneId)) return;
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
 * so it is decorated with the same winsize ownership `pty.create` gets.
 */
export function ptyReset(
  ctx: HandlerCtx<PtySessionDeps & BridgeServerDeps>,
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
  /** The host the fresh session runs on. */
  hostId?: string;
} & PtyWinsize;

async function resetSession(
  deps: PtySessionDeps,
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
      // Started fresh: there was nothing to snapshot.
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
 * Hand out the background-warmed session, if one is ready and it
 * sits where the caller is asking for one — the renderer names the
 * workspace's host alongside its cwd.
 */
export function ptyConsumePrewarmed(
  ctx: HandlerCtx<ServerDeps>,
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
  ctx: HandlerCtx<ServerDeps>,
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

/**
 * Routed by pane: a pane on an adopted host is that host
 * server's terminal, so on the desktop each call for one is forwarded there
 * (`HostRouting`), and its events come back keyed by pane (`HostProxy`). A
 * new pane's create and reset name the host in their options.
 */
export const pty = {
  // Starting or ending a session is audited; `write` is the keyboard, and a
  // line per keystroke is a keylogger. `resize` and `detach` are
  // what a viewer does to its own view.
  create: method(ptyCreate, { mutating: true, route: byPane(0, 4) }),
  // Never starts a session: a viewer coming back to one, like `detach`.
  attach: method(ptyAttach, { route: byPane(0) }),
  reset: method(ptyReset, { mutating: true, route: byPane(0, 4) }),
  write: method(ptyWrite, { route: byPane(0) }),
  resize: method(ptyResize, { route: byPane(0) }),
  claimWinsize: method(ptyClaimWinsize, { route: byPane(0) }),
  close: method(ptyClose, { mutating: true, route: byPane(0) }),
  detach: method(ptyDetach, { route: byPane(0) }),
  // One prewarmed session per host, and its cwd tracks the primary window's
  // workspace: a device adopting it gets a shell somewhere else, and a device
  // moving it moves the desktop's out from under it.
  consumePrewarmed: method(ptyConsumePrewarmed, { localOnly: true }),
  updatePrewarmCwd: method(ptyUpdatePrewarmCwd, { localOnly: true }),
};
