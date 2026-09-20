import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

// Track in-flight pushes for cancellation, keyed by pushId (= workspace path).
const activePushes = new Map<string, { cancel: () => void }>();

/** Cancel all in-flight pushes. Called by app-lifecycle on before-quit. */
export function killAllActivePushes(): void {
  for (const [, entry] of activePushes) {
    entry.cancel();
  }
}

/**
 * The branch and diff watchers, lifted for the ADR-180 ticket 8 crossing —
 * the two of the four `git:*` families this file used to register that are
 * not `git.*` itself. `git.*` (stage, unstage, commit, push, discard, stash,
 * the diff reads) stays behind `register()` below: it crosses with
 * `github`/`linear`/`remoteControl` under ADR-180 ticket 10, not here.
 */
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
 * What is left once `branches` and `diffs` cross (ADR-180 ticket 8): the
 * `git:*` writes and the push-progress stream, which stay `ipcMain.handle`
 * wrappers until ticket 10 lifts them alongside `github` and `linear`.
 */
export function register(deps: IpcDeps): void {
  const { backend } = deps;

  // ── Git Operations ──
  ipcMain.handle("git:stage", async (_event, wsPath: string, files: string[]) => {
    assertString(wsPath, "wsPath");
    await backend.git.stage(wsPath, files);
  });

  ipcMain.handle("git:unstage", async (_event, wsPath: string, files: string[]) => {
    assertString(wsPath, "wsPath");
    await backend.git.unstage(wsPath, files);
  });

  ipcMain.handle("git:discard", async (_event, wsPath: string, files: string[]) => {
    assertString(wsPath, "wsPath");
    await backend.git.discard(wsPath, files);
  });

  ipcMain.handle("git:stash", async (_event, wsPath: string, files: string[]) => {
    assertString(wsPath, "wsPath");
    await backend.git.stash(wsPath, files);
  });

  ipcMain.handle("git:commit", async (_event, wsPath: string, message: string, flags: string[]) => {
    assertString(wsPath, "wsPath");
    await backend.git.commit(wsPath, message, flags);
  });

  ipcMain.handle(
    "git:push:start",
    async (event, args: { wsPath: string; setUpstream?: boolean }) => {
      assertString(args.wsPath, "wsPath");
      const pushId = args.wsPath;

      if (activePushes.has(pushId)) {
        throw new Error("Push already in progress for this workspace");
      }

      const webContents = event.sender;

      const { cancel } = backend.git.pushStream(
        args.wsPath,
        { setUpstream: args.setUpstream },
        {
          onLine(line) {
            if (!webContents.isDestroyed()) {
              webContents.send("git:push:progress", { pushId, type: "line", line });
            }
          },
          onDone({ exitCode, stderr }) {
            activePushes.delete(pushId);
            if (!webContents.isDestroyed()) {
              webContents.send("git:push:progress", { pushId, type: "done", exitCode, stderr });
            }
          },
        },
      );

      activePushes.set(pushId, { cancel });

      return { pushId, startedAt: Date.now() };
    },
  );

  ipcMain.handle("git:push:cancel", (_event, args: { pushId: string }) => {
    const entry = activePushes.get(args.pushId);
    if (entry) {
      // Do NOT remove from map here — let onDone remove it so the done event still fires.
      entry.cancel();
    }
  });
}
