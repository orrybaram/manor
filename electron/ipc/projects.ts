import { ipcMain } from "electron";
import { assertGroupUpdates, assertString } from "../ipc-validate";
import type { GroupUpdatableFields, ProjectUpdatableFields } from "../persistence";
import type { LinkedIssue } from "../linear";
import { LOCAL_HOST_ID } from "../backend/types";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { projectManager, statsStore, backendRegistry } = deps;

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
    "projects:addRemote",
    async (
      _event,
      opts: { hostId: string; repoUrl: string; remoteDir: string; name: string },
    ) => {
      assertString(opts?.hostId, "hostId");
      assertString(opts?.repoUrl, "repoUrl");
      assertString(opts?.remoteDir, "remoteDir");
      assertString(opts?.name, "name");
      projectManager.assertRemoteHost(opts.hostId);
      // Connect (and start the box, for a managed provider) before cloning —
      // a clone against a host that never got the chance to connect would
      // just fail with a confusing "unavailable" error.
      await backendRegistry.ensureConnected(opts.hostId);
      return projectManager.addRemoteProject(opts);
    },
  );

  // ADR-179: clone (or adopt) an existing project's repo onto a remote host
  // and point the same project record at it.
  ipcMain.handle(
    "projects:moveToHost",
    async (
      _event,
      projectId: string,
      opts: { hostId: string; repoUrl: string; remoteDir: string },
    ) => {
      assertString(projectId, "projectId");
      assertString(opts?.hostId, "hostId");
      assertString(opts?.repoUrl, "repoUrl");
      assertString(opts?.remoteDir, "remoteDir");
      projectManager.assertRemoteHost(opts.hostId);
      await backendRegistry.ensureConnected(opts.hostId);
      return projectManager.moveProjectToHost(projectId, opts);
    },
  );

  ipcMain.handle("projects:getOriginUrl", (_event, projectId: string) => {
    assertString(projectId, "projectId");
    return projectManager.getOriginUrl(projectId);
  });

  ipcMain.handle("projects:pathExists", (_event, projectId: string) => {
    assertString(projectId, "projectId");
    return projectManager.projectPathExists(projectId);
  });

  ipcMain.handle(
    "projects:selectWorkspace",
    (_event, projectId: string, workspaceIndex: number) => {
      projectManager.selectWorkspace(projectId, workspaceIndex);
    },
  );

  ipcMain.handle(
    "projects:removeWorktree",
    async (event, projectId: string, worktreePath: string, deleteBranch?: boolean) => {
      const result = await projectManager.removeWorktree(
        projectId,
        worktreePath,
        deleteBranch,
        (step: string) => {
          event.sender.send("projects:removeWorktree:progress", step);
        },
      );
      statsStore.record("worktreesRemoved");
      return result;
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
    async (_event, projectId: string, worktreePath: string) => {
      const result = await projectManager.quickMergeWorktree(projectId, worktreePath);
      statsStore.record("worktreesMerged");
      return result;
    },
  );

  ipcMain.handle(
    "projects:createWorktree",
    async (_event, projectId: string, name: string, branch?: string, linkedIssue?: LinkedIssue, baseBranch?: string, useExistingBranch?: boolean) => {
      const result = await projectManager.createWorktree(projectId, name, branch, linkedIssue, baseBranch, useExistingBranch);
      statsStore.record("worktreesCreated");
      return result;
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
    "projects:setWorkspaceHidden",
    (_event, projectId: string, workspacePath: string, hidden: boolean) => {
      projectManager.setWorkspaceHidden(projectId, workspacePath, hidden);
    },
  );

  ipcMain.handle(
    "projects:createWorkspaceFolder",
    (_event, projectId: string, name: string, parentId?: string | null) => {
      assertString(name, "name");
      return projectManager.createWorkspaceFolder(projectId, name, parentId);
    },
  );

  // Returns false when the move would create a folder cycle (ADR-172).
  ipcMain.handle(
    "projects:setFolderParent",
    (_event, projectId: string, folderId: string, parentId: string | null) => {
      return projectManager.setFolderParent(projectId, folderId, parentId);
    },
  );

  ipcMain.handle(
    "projects:renameWorkspaceFolder",
    (_event, projectId: string, folderId: string, name: string) => {
      assertString(name, "name");
      projectManager.renameWorkspaceFolder(projectId, folderId, name);
    },
  );

  ipcMain.handle(
    "projects:deleteWorkspaceFolder",
    (_event, projectId: string, folderId: string) => {
      projectManager.deleteWorkspaceFolder(projectId, folderId);
    },
  );

  ipcMain.handle(
    "projects:setWorkspaceFolder",
    (
      _event,
      projectId: string,
      workspacePath: string,
      folderId: string | null,
    ) => {
      projectManager.setWorkspaceFolder(projectId, workspacePath, folderId);
    },
  );

  // orderedKeys entries may be workspace paths or folder ids (ADR-167).
  ipcMain.handle(
    "projects:reorderWorkspaces",
    (_event, projectId: string, orderedKeys: string[]) => {
      projectManager.reorderWorkspaces(projectId, orderedKeys);
    },
  );

  ipcMain.handle("projects:reorder", (_event, orderedIds: string[]) => {
    projectManager.reorderProjects(orderedIds);
  });

  // ADR-192: link two projects on different hosts into one group, or take
  // one out of its group. A project leaving keeps the group's shared
  // settings; nothing else about it changes.
  ipcMain.handle("projects:link", (_event, projectId: string, otherId: string) => {
    assertString(projectId, "projectId");
    assertString(otherId, "otherId");
    return projectManager.linkProjects(projectId, otherId);
  });

  ipcMain.handle("projects:unlink", (_event, projectId: string) => {
    assertString(projectId, "projectId");
    projectManager.unlinkProject(projectId);
  });

  ipcMain.handle("projects:unlinkGroup", (_event, groupId: string) => {
    assertString(groupId, "groupId");
    projectManager.unlinkGroup(groupId);
  });

  // ADR-192 ticket 2: set a group's shared settings. Returns every member.
  ipcMain.handle(
    "projects:updateGroup",
    (_event, groupId: unknown, updates: unknown) => {
      assertString(groupId, "groupId");
      assertGroupUpdates(updates, "updates");
      const { linearAssociations, ...rest } = updates;
      const clean: GroupUpdatableFields = { ...rest };
      // Null clears the group's teams.
      if (linearAssociations !== undefined) clean.linearAssociations = linearAssociations ?? [];
      return projectManager.updateGroup(groupId, clean);
    },
  );

  // ADR-192: the host the New Workspace picker starts on next time.
  ipcMain.handle(
    "projects:setGroupLastUsedHost",
    (_event, groupId: string, hostId: string) => {
      assertString(groupId, "groupId");
      assertString(hostId, "hostId");
      projectManager.setGroupLastUsedHost(groupId, hostId);
    },
  );

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

  // ADR-179: switch a project to a host without cloning — to `path`, or the
  // path it last had there. Refused when that path doesn't exist on the host.
  ipcMain.handle(
    "projects:switchHost",
    (_event, projectId: string, hostId: string, projectPath?: string) => {
      assertString(projectId, "projectId");
      assertString(hostId, "hostId");
      if (projectPath !== undefined) assertString(projectPath, "path");
      projectManager.assertKnownHost(hostId);
      return switchHost(projectId, hostId, projectPath);
    },
  );

  async function switchHost(
    projectId: string,
    hostId: string,
    projectPath?: string,
  ) {
    if (hostId !== LOCAL_HOST_ID) {
      await backendRegistry.ensureConnected(hostId);
    }
    return projectManager.switchProjectHost(projectId, hostId, projectPath);
  }
}
