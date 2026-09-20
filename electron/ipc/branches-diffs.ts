/**
 * Branches, diffs and the `git.*` writes, as plain functions over `IpcDeps`
 * (ADR-180 D8).
 *
 * There is no `register()` here any more. Ticket 8 crossed the two watchers
 * and the three diff reads and thinned this file's wrapper down to the seven
 * `git:*` handlers; ticket 10 lifts those too, so `electron/bridge/handlers.ts`
 * is the only caller of everything below — a renderer window and a paired
 * `full` device alike.
 *
 * **`git.commit` and `git.push` are the reason `MUTATING` has the wording it
 * does.** They are the clearest case of "moves state the other viewers of
 * this host will see": a commit rewrites what every sidebar badge, diff pane
 * and PR check on this machine is looking at, and a push does it on the
 * remote as well. Both leave an audit line when a device makes them and none
 * when the user at the machine does (D4).
 *
 * **Push progress goes back to the caller, not to every window.** It used to
 * ride `event.sender` — the one thing a lifted function does not have — so
 * the caller arrives as a `LayoutOrigin` instead (`ORIGIN_ARGS`, ADR-179 D3)
 * and the lines become a `git.push.progress` event addressed to that
 * connection, exactly as `projects.createWorktree`'s setup progress does. One
 * push dialog, in one window; a second window has no business watching its
 * progress bar.
 */

import { assertString } from "../ipc-validate";
import {
  publishRendererBroadcast,
  publishToRenderer,
} from "../renderer-broadcast";
import type { LayoutOrigin } from "../layout/layout-store";
import type { IpcDeps } from "./types";

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

/** The branch and diff watchers, lifted for the ADR-180 ticket 8 crossing. */
export function branchesStart(deps: IpcDeps, paths: string[]): void {
  deps.branchWatcher.start(paths);
}

export function branchesStop(deps: IpcDeps): void {
  deps.branchWatcher.stop();
}

export function diffsStart(
  deps: IpcDeps,
  workspaces: Record<string, string>,
): void {
  deps.diffWatcher.start(workspaces);
}

export function diffsStop(deps: IpcDeps): void {
  deps.diffWatcher.stop();
}

export function diffsGetFullDiff(
  deps: IpcDeps,
  wsPath: string,
  defaultBranch: string,
): Promise<string | null> {
  return deps.backend.git.getFullDiff(wsPath, defaultBranch);
}

export function diffsGetLocalDiff(
  deps: IpcDeps,
  wsPath: string,
): Promise<string | null> {
  return deps.backend.git.getLocalDiff(wsPath);
}

export function diffsGetStagedFiles(
  deps: IpcDeps,
  wsPath: string,
): Promise<string[]> {
  assertString(wsPath, "wsPath");
  return deps.backend.git.getStagedFiles(wsPath);
}

/**
 * The `git.*` writes, lifted for ADR-180 ticket 10.
 *
 * Each keeps the `assertString` the wrapper ran, so a frame off the socket is
 * validated exactly as a desktop call is — which is the whole reason the
 * table calls these rather than reaching into Electron's handler map.
 */
export async function gitStage(
  deps: IpcDeps,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await deps.backend.git.stage(wsPath, files);
}

export async function gitUnstage(
  deps: IpcDeps,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await deps.backend.git.unstage(wsPath, files);
}

export async function gitDiscard(
  deps: IpcDeps,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await deps.backend.git.discard(wsPath, files);
}

export async function gitStash(
  deps: IpcDeps,
  wsPath: string,
  files: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await deps.backend.git.stash(wsPath, files);
}

export async function gitCommit(
  deps: IpcDeps,
  wsPath: string,
  message: string,
  flags: string[],
): Promise<void> {
  assertString(wsPath, "wsPath");
  await deps.backend.git.commit(wsPath, message, flags);
}

/**
 * Start a push, streaming its output back to whoever asked for it.
 *
 * `pushId` is the workspace path, which is also the lock: one push per
 * workspace, and a second caller — another window, a phone — is told so
 * rather than racing the first. The stream is addressed to the caller's
 * connection; a call with no origin behind it (the CLI, a test) broadcasts,
 * which is what every window used to get from `event.sender` anyway when the
 * sender happened to be the only one open.
 */
export function gitPushStart(
  deps: IpcDeps,
  args: { wsPath: string; setUpstream?: boolean },
  origin?: LayoutOrigin,
): { pushId: string; startedAt: number } {
  assertString(args.wsPath, "wsPath");
  const pushId = args.wsPath;

  if (activePushes.has(pushId)) {
    throw new Error("Push already in progress for this workspace");
  }

  const to = origin?.id ?? null;
  const report = (event: PushProgressEvent) => {
    if (to === null) publishRendererBroadcast("git.push", "progress", event);
    else publishToRenderer(to, "git.push", "progress", event);
  };

  const { cancel } = deps.backend.git.pushStream(
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
export function gitPushCancel(_deps: IpcDeps, pushId: string): void {
  const entry = activePushes.get(pushId);
  if (!entry) return;
  // Do NOT remove from the map here — let `onDone` remove it so the done
  // event still fires.
  entry.cancel();
}
