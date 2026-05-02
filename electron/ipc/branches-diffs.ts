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

export function register(deps: IpcDeps): void {
  const { branchWatcher, diffWatcher, backend } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  // ── Branch Watcher ──
  ipcMain.handle("branches:start", (_event, paths: string[]) => {
    branchWatcher.start(getMainWindow()!, paths);
  });

  ipcMain.handle("branches:stop", () => {
    branchWatcher.stop();
  });

  // ── Diff Watcher ──
  ipcMain.handle("diffs:start", (_event, workspaces: Record<string, string>) => {
    diffWatcher.start(getMainWindow()!, workspaces);
  });

  ipcMain.handle("diffs:stop", () => {
    diffWatcher.stop();
  });

  ipcMain.handle(
    "diffs:getFullDiff",
    async (_event, wsPath: string, defaultBranch: string) => {
      return backend.git.getFullDiff(wsPath, defaultBranch);
    },
  );

  ipcMain.handle(
    "diffs:getLocalDiff",
    async (_event, wsPath: string) => {
      return backend.git.getLocalDiff(wsPath);
    },
  );

  ipcMain.handle(
    "diffs:getStagedFiles",
    async (_event, wsPath: string) => {
      assertString(wsPath, "wsPath");
      return backend.git.getStagedFiles(wsPath);
    },
  );

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
