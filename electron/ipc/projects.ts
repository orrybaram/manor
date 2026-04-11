import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { ProjectUpdatableFields } from "../persistence";
import type { LinkedIssue } from "../linear";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { projectManager } = deps;

  function getMainWindow() {
    return deps.mainWindow;
  }

  ipcMain.handle("projects:getAll", () => {
    return projectManager.getProjects();
  });

  ipcMain.handle("projects:getSelectedIndex", () => {
    return projectManager.getSelectedProjectIndex();
  });

  ipcMain.handle("projects:select", (_event, index: number) => {
    projectManager.selectProject(index);
  });

  ipcMain.handle("projects:add", (_event, name: string, projectPath: string) => {
    assertString(name, "name");
    assertString(projectPath, "path");
    return projectManager.addProject(name, projectPath);
  });

  ipcMain.handle("projects:remove", (_event, projectId: string) => {
    projectManager.removeProject(projectId);
  });

  ipcMain.handle(
    "projects:selectWorkspace",
    (_event, projectId: string, workspaceIndex: number) => {
      projectManager.selectWorkspace(projectId, workspaceIndex);
    },
  );

  ipcMain.handle(
    "projects:removeWorktree",
    (event, projectId: string, worktreePath: string, deleteBranch?: boolean) => {
      return projectManager.removeWorktree(
        projectId,
        worktreePath,
        deleteBranch,
        (step: string) => {
          event.sender.send("projects:removeWorktree:progress", step);
        },
      );
    },
  );

  ipcMain.handle(
    "projects:canQuickMerge",
    (_event, projectId: string, worktreePath: string) => {
      return projectManager.canQuickMerge(projectId, worktreePath);
    },
  );

  ipcMain.handle(
    "projects:quickMergeWorktree",
    (_event, projectId: string, worktreePath: string) => {
      return projectManager.quickMergeWorktree(projectId, worktreePath);
    },
  );

  ipcMain.handle(
    "projects:createWorktree",
    (_event, projectId: string, name: string, branch?: string, linkedIssue?: LinkedIssue, baseBranch?: string, useExistingBranch?: boolean) => {
      return projectManager.createWorktree(projectId, name, branch, linkedIssue, baseBranch, useExistingBranch);
    },
  );

  ipcMain.handle(
    "projects:convertMainToWorktree",
    (_event, projectId: string, name: string) => {
      return projectManager.convertMainToWorktree(projectId, name);
    },
  );

  ipcMain.handle("projects:listRemoteBranches", (_e, projectId: string) =>
    projectManager.listRemoteBranches(projectId),
  );

  ipcMain.handle("projects:listLocalBranches", (_e, projectId: string) =>
    projectManager.listLocalBranches(projectId),
  );

  ipcMain.handle(
    "projects:renameWorkspace",
    (_event, projectId: string, workspacePath: string, newName: string) => {
      projectManager.renameWorkspace(projectId, workspacePath, newName);
    },
  );

  ipcMain.handle(
    "projects:reorderWorkspaces",
    (_event, projectId: string, orderedPaths: string[]) => {
      projectManager.reorderWorkspaces(projectId, orderedPaths);
    },
  );

  ipcMain.handle("projects:reorder", (_event, orderedIds: string[]) => {
    projectManager.reorderProjects(orderedIds);
  });

  ipcMain.handle(
    "projects:update",
    (
      _event,
      projectId: string,
      updates: ProjectUpdatableFields,
    ) => {
      return projectManager.updateProject(projectId, updates);
    },
  );
}
