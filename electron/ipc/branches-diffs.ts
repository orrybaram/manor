import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

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

  ipcMain.handle("git:push", async (_event, wsPath: string, remote?: string, branch?: string) => {
    assertString(wsPath, "wsPath");
    await backend.git.push(wsPath, remote, branch);
  });
}
