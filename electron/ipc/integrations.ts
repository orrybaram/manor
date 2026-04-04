import { ipcMain } from "electron";
import { assertString } from "../ipc-validate";
import type { IpcDeps } from "./types";

export function register(deps: IpcDeps): void {
  const { githubManager, linearManager, projectManager } = deps;

  // ── GitHub IPC ──
  ipcMain.handle(
    "github:getPrForBranch",
    (_event, repoPath: string, branch: string) => {
      return githubManager.getPrForBranch(repoPath, branch);
    },
  );

  ipcMain.handle(
    "github:getPrsForBranches",
    (_event, repoPath: string, branches: string[]) => {
      return githubManager.getPrsForBranches(repoPath, branches);
    },
  );

  ipcMain.handle("github:checkStatus", () => githubManager.checkStatus());

  ipcMain.handle(
    "github:getMyIssues",
    (_event, repoPath: string, limit?: number, state?: "open" | "closed" | "all") => {
      return githubManager.getMyIssues(repoPath, limit, state);
    },
  );

  ipcMain.handle(
    "github:getAllIssues",
    (_event, repoPath: string, limit?: number, state?: "open" | "closed" | "all") => {
      return githubManager.getAllIssues(repoPath, limit, state);
    },
  );

  ipcMain.handle(
    "github:getIssueDetail",
    (_event, repoPath: string, issueNumber: number) => {
      return githubManager.getIssueDetail(repoPath, issueNumber);
    },
  );

  ipcMain.handle(
    "github:assignIssue",
    (_event, repoPath: string, issueNumber: number) => {
      return githubManager.assignIssue(repoPath, issueNumber);
    },
  );

  ipcMain.handle(
    "github:closeIssue",
    (_event, repoPath: string, issueNumber: number) => {
      return githubManager.closeIssue(repoPath, issueNumber);
    },
  );

  ipcMain.handle(
    "github:createIssue",
    (_event, title: string, body: string, labels: string[]) => {
      return githubManager.createIssue(title, body, labels);
    },
  );

  ipcMain.handle(
    "github:uploadFeedbackImages",
    (_event, images: { base64: string; name: string }[]) => {
      return githubManager.uploadFeedbackImages(images);
    },
  );

  // ── Linear IPC ──
  ipcMain.handle("linear:connect", async (_event, apiKey: string) => {
    assertString(apiKey, "apiKey");
    linearManager.saveToken(apiKey);
    try {
      const viewer = await linearManager.getViewer();
      return viewer;
    } catch (err) {
      linearManager.clearToken();
      throw err;
    }
  });

  ipcMain.handle("linear:disconnect", () => {
    linearManager.clearToken();
  });

  ipcMain.handle("linear:isConnected", () => {
    return linearManager.isConnected();
  });

  ipcMain.handle("linear:getViewer", async () => {
    return linearManager.getViewer();
  });

  ipcMain.handle("linear:getTeams", async () => {
    return linearManager.getTeams();
  });

  ipcMain.handle(
    "linear:getMyIssues",
    async (
      _event,
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => {
      return linearManager.getMyIssues(teamIds, options);
    },
  );

  ipcMain.handle("linear:getIssueDetail", async (_event, issueId: string) => {
    return linearManager.getIssueDetail(issueId);
  });

  ipcMain.handle(
    "linear:getAllIssues",
    async (
      _event,
      teamIds: string[],
      options?: { stateTypes?: string[]; limit?: number },
    ) => {
      return linearManager.getAllIssues(teamIds, options);
    },
  );

  ipcMain.handle("linear:startIssue", async (_event, issueId: string) => {
    return linearManager.startIssue(issueId);
  });

  ipcMain.handle("linear:closeIssue", async (_event, issueId: string) => {
    return linearManager.closeIssue(issueId);
  });

  ipcMain.handle(
    "linear:linkIssueToWorkspace",
    (_e, projectId: string, workspacePath: string, issue: import("../linear").LinkedIssue) =>
      projectManager.linkIssueToWorkspace(projectId, workspacePath, issue),
  );

  ipcMain.handle(
    "linear:unlinkIssueFromWorkspace",
    (_e, projectId: string, workspacePath: string, issueId: string) =>
      projectManager.unlinkIssueFromWorkspace(projectId, workspacePath, issueId),
  );

  ipcMain.handle("linear:autoMatch", async () => {
    const projects = await projectManager.getProjects();
    const teams = await linearManager.getTeams();
    const matches = linearManager.autoMatchProjects(
      projects.map((p) => ({ id: p.id, name: p.name })),
      teams,
    );
    // Apply matches to projects without existing associations
    for (const [projectId, association] of Object.entries(matches)) {
      const project = projects.find((p) => p.id === projectId);
      if (project && project.linearAssociations.length === 0) {
        projectManager.updateProject(projectId, {
          linearAssociations: [association],
        });
      }
    }
    return matches;
  });
}
