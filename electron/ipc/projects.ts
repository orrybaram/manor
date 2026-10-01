import { ipcMain } from "electron";
import { assertGroupUpdates, assertString } from "../ipc-validate";
import type { GroupUpdatableFields, ProjectUpdatableFields } from "../persistence";
import type { LinkedIssue } from "../linear";
import { LOCAL_HOST_ID } from "../backend/types";
import type { IpcDeps } from "./types";
import type { ProjectInfo } from "../persistence";
import { workspaceKey } from "../../src/lib/workspace-key";

/**
 * The four the sidebar needs to paint itself, lifted out of their
 * `ipcMain.handle` wrappers so the ADR-178 WebSocket bridge calls the same
 * code the desktop renderer does. The two selection calls are the only
 * `projects` *writes* on the bridge's slice-1 table; everything that creates,
 * removes or merges a workspace stays desktop-only until a later slice.
 */
export function projectsGetAll(deps: IpcDeps): unknown {
  return deps.projectManager.getProjects();
}

export function projectsGetSelectedIndex(deps: IpcDeps): number {
  return deps.projectManager.getSelectedProjectIndex();
}

export function projectsSelect(deps: IpcDeps, index: number): void {
  deps.projectManager.selectProject(index);
}

export function projectsSelectWorkspace(
  deps: IpcDeps,
  projectId: string,
  workspaceIndex: number,
): void {
  deps.projectManager.selectWorkspace(projectId, workspaceIndex);
}

export function register(deps: IpcDeps): void {
  const { projectManager, workspaceOps, backendRegistry, layoutStore } = deps;

  /**
   * A project that moved from `oldHostId` keeps the saved layouts of the
   * workspaces it still has, under their keys on its new host (ADR-191 §3).
   * The layout store owns them (ADR-179 D1) and broadcasts the move, so every
   * renderer's replica follows.
   */
  async function moveLayouts(oldHostId: string, moved: ProjectInfo): Promise<ProjectInfo> {
    if (oldHostId !== moved.hostId) {
      await layoutStore.moveWorkspaces(
        moved.workspaces.map((ws) => [
          workspaceKey(oldHostId, ws.path),
          workspaceKey(moved.hostId, ws.path),
        ]),
      );
    }
    return moved;
  }

  ipcMain.handle("projects:getAll", () => projectsGetAll(deps));

  ipcMain.handle("projects:getRemote", () => {
    return projectManager.getRemoteProjects();
  });

  ipcMain.handle("projects:getSelectedIndex", () =>
    projectsGetSelectedIndex(deps),
  );

  ipcMain.handle("projects:select", (_event, index: number) => {
    projectsSelect(deps, index);
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
    "projects:clone",
    async (
      _event,
      opts: { hostId: string; repoUrl: string; targetDir: string; name: string },
    ) => {
      assertString(opts?.hostId, "hostId");
      assertString(opts?.repoUrl, "repoUrl");
      assertString(opts?.targetDir, "targetDir");
      assertString(opts?.name, "name");
      projectManager.assertKnownHost(opts.hostId);
      // Connect (and start the box, for a managed provider) before cloning —
      // a clone against a host that never got the chance to connect would
      // just fail with a confusing "unavailable" error. This machine is
      // always connected.
      if (opts.hostId !== LOCAL_HOST_ID) await backendRegistry.ensureConnected(opts.hostId);
      return projectManager.cloneProject(opts);
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
      const oldHostId = projectManager.getProjectHostId(projectId);
      return moveLayouts(oldHostId, await projectManager.moveProjectToHost(projectId, opts));
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
      projectsSelectWorkspace(deps, projectId, workspaceIndex);
    },
  );

  ipcMain.handle(
    "projects:removeWorktree",
    async (event, projectId: string, worktreePath: string, deleteBranch?: boolean) => {
      await workspaceOps.remove(projectId, worktreePath, deleteBranch, (step: string) => {
        event.sender.send("projects:removeWorktree:progress", step);
      });
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
      await workspaceOps.quickMerge(projectId, worktreePath);
    },
  );

  ipcMain.handle(
    "projects:createWorktree",
    async (_event, projectId: string, name: string, branch?: string, linkedIssue?: LinkedIssue, baseBranch?: string, useExistingBranch?: boolean) => {
      // The renderer runs the setup script itself (its pending setup view may
      // launch an agent alongside it), so main must not (ADR-203).
      const { project } = await workspaceOps.create(
        { projectId, name, branch, linkedIssue, baseBranch, useExistingBranch },
        { runSetupScript: false },
      );
      return project;
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

  // ADR-192 ticket 5: projects on other hosts with the same `origin`, to
  // offer as links after an add or clone. Suggests only; never links.
  ipcMain.handle("projects:suggestLinks", (_event, projectId: string) => {
    assertString(projectId, "projectId");
    return projectManager.suggestLinks(projectId);
  });

  ipcMain.handle(
    "projects:dismissLinkSuggestion",
    (_event, projectId: string, otherId: string) => {
      assertString(projectId, "projectId");
      assertString(otherId, "otherId");
      projectManager.dismissLinkSuggestion(projectId, otherId);
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
    const oldHostId = projectManager.getProjectHostId(projectId);
    return moveLayouts(
      oldHostId,
      await projectManager.switchProjectHost(projectId, hostId, projectPath),
    );
  }
}
