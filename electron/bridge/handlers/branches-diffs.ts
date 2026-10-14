/**
 * Branches, diffs and the `git.*` writes (ADR-180 D8), as the `branches`,
 * `diffs`, `git` and `git.push` namespaces of the handler table.
 *
 * **`git.commit` and `git.push` are the reason `mutating` has the wording it
 * does.** They are the clearest case of "moves state the other viewers of
 * this host will see": a commit rewrites what every sidebar badge, diff pane
 * and PR check on this machine is looking at, and a push does it on the
 * remote as well. Both leave an audit line when a device makes them and none
 * when the user at the machine does (D4).
 *
 * **Push progress goes back to the caller, not to every window**, as a
 * `git.push.progress` event addressed to `ctx.caller.id` — exactly as
 * `projects.createWorktree`'s setup progress does. One push dialog, in one
 * window; a second window has no business watching its progress bar.
 */

import { assertHostPaths, assertString } from "../../ipc-validate";
import { publishToRenderer } from "../../renderer-broadcast";
import type { HostPath } from "../../per-host-poller";
import type { DiffWorkspace } from "../../diff-watcher";
import { LOCAL_ROUTE, method, type HandlerCtx } from "../method";
import type { ServerDeps } from "../../ipc/types";

/** What one `git.push.progress` frame carries. */
export type PushProgressEvent =
  | { pushId: string; type: "line"; line: string }
  | { pushId: string; type: "done"; exitCode: number | null; stderr: string };

// Track in-flight pushes for cancellation, keyed by pushId (= workspace path).
const activePushes = new Map<string, { cancel: () => void }>();

/** Cancel all in-flight pushes. Called by app-lifecycle on before-quit. */
export function killAllActivePushes(): void {
  for (const [, entry] of activePushes) {
    entry.cancel();
  }
}

/**
 * The branch and diff watchers. Workspaces arrive with their project's host
 * (ADR-183), and each connection's are its own (ADR-230 D6): the watcher
 * polls every connection's, and a caller's stop, or its connection closing
 * (`createManorServer`), takes only the caller's away.
 */
type WatcherDeps = Pick<ServerDeps, "branchWatcher" | "diffWatcher">;

export function branchesStart(
  ctx: HandlerCtx<WatcherDeps>,
  workspaces: readonly HostPath[],
): void {
  const value: unknown = workspaces;
  assertHostPaths(value, "workspaces");
  ctx.deps.branchWatcher.start(value, ctx.caller.id);
}

export function branchesStop(ctx: HandlerCtx<WatcherDeps>): void {
  ctx.deps.branchWatcher.stop(ctx.caller.id);
}

export function diffsStart(
  ctx: HandlerCtx<WatcherDeps>,
  workspaces: readonly DiffWorkspace[],
): void {
  const value: unknown = workspaces;
  assertHostPaths(value, "workspaces", ["defaultBranch"]);
  ctx.deps.diffWatcher.start(value, ctx.caller.id);
}

export function diffsStop(ctx: HandlerCtx<WatcherDeps>): void {
  ctx.deps.diffWatcher.stop(ctx.caller.id);
}

export function diffsGetFullDiff(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  defaultBranch: string,
): Promise<string | null> {
  return ctx.deps.backend.git.getFullDiff(wsPath, defaultBranch);
}

export function diffsGetLocalDiff(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
): Promise<string | null> {
  return ctx.deps.backend.git.getLocalDiff(wsPath);
}

export function diffsGetStagedFiles(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
): Promise<string[]> {
  assertString(wsPath, "wsPath");
  return ctx.deps.backend.git.getStagedFiles(wsPath);
}

/**
 * The `git.*` writes.
 *
 * Each keeps the `assertString` the wrapper ran, so a frame off the socket is
 * validated exactly as a desktop call is — which is the whole reason the
 * table calls these rather than reaching into Electron's handler map.
 */
export async function gitStage(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await ctx.deps.backend.git.stage(wsPath, files);
}

export async function gitUnstage(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await ctx.deps.backend.git.unstage(wsPath, files);
}

export async function gitDiscard(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await ctx.deps.backend.git.discard(wsPath, files);
}

export async function gitStash(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await ctx.deps.backend.git.stash(wsPath, files);
}

export async function gitCommit(
  ctx: HandlerCtx<ServerDeps>,
  wsPath: string,
  message: string,
  flags: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await ctx.deps.backend.git.commit(wsPath, message, flags);
}

/**
 * Start a push, streaming its output back to whoever asked for it.
 *
 * `pushId` is the workspace path, which is also the lock: one push per
 * workspace, and a second caller — another window, a phone — is told so
 * rather than racing the first.
 */
export function gitPushStart(
  ctx: HandlerCtx<ServerDeps>,
  args: { wsPath: string; setUpstream?: boolean },
): { pushId: string; startedAt: number } {
  assertString(args.wsPath, "wsPath");
  const pushId = args.wsPath;

  if (activePushes.has(pushId)) {
    throw new Error("Push already in progress for this workspace");
  }

  const report = (event: PushProgressEvent) => {
    publishToRenderer(ctx.caller.id, "git.push", "progress", event);
  };

  const { cancel } = ctx.deps.backend.git.pushStream(
    args.wsPath,
    { setUpstream: args.setUpstream },
    {
      onLine(line) {
        report({ pushId, type: "line", line });
      },
      onDone({ exitCode, stderr }) {
        activePushes.delete(pushId);
        report({ pushId, type: "done", exitCode, stderr });
      },
    },
  );

  activePushes.set(pushId, { cancel });

  return { pushId, startedAt: Date.now() };
}

/**
 * Cancel one. The wrapper took a `{ pushId }` envelope because the preload
 * built one; the table passes the id the caller actually named.
 */
export function gitPushCancel(
  _ctx: HandlerCtx<ServerDeps>,
  pushId: string,
): void {
  const entry = activePushes.get(pushId);
  if (!entry) return;
  // Do NOT remove from the map here — let `onDone` remove it so the done
  // event still fires.
  entry.cancel();
}

// The watcher lifecycle and the reads are what a viewer does to its own view,
// so none of `branches` or `diffs` is audited. Each server watches its own
// machine's workspaces, and a desktop polls its hosts' through their
// backends: the watch is split by the renderer's router (ADR-230 D6, the
// `"split"` route), never forwarded by main.
export const branches = {
  start: method(branchesStart, { route: LOCAL_ROUTE }),
  stop: method(branchesStop, { route: LOCAL_ROUTE }),
};

export const diffs = {
  start: method(diffsStart, { route: LOCAL_ROUTE }),
  stop: method(diffsStop, { route: LOCAL_ROUTE }),
  getFullDiff: method(diffsGetFullDiff),
  getLocalDiff: method(diffsGetLocalDiff),
  getStagedFiles: method(diffsGetStagedFiles),
};

// Nothing here merely reads, and nothing is local-only: committing from a
// phone is the sentence ADR-178 started from. Staging moves the index every
// other viewer's diff pane reads; `discard` and `stash` take work away.
export const git = {
  stage: method(gitStage, { mutating: true }),
  unstage: method(gitUnstage, { mutating: true }),
  discard: method(gitDiscard, { mutating: true }),
  stash: method(gitStash, { mutating: true }),
  commit: method(gitCommit, { mutating: true }),
};

/**
 * A namespace of its own, not a method: `git.push.start` is the only
 * two-level path in the surface, and the client proxy resolves it as ns
 * `git.push` (`src/bridge/client.ts`'s `member`). `cancel` ends a push
 * somebody is watching.
 */
export const gitPush = {
  start: method(gitPushStart, { mutating: true }),
  cancel: method(gitPushCancel, { mutating: true }),
};
