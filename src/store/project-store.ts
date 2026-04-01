import { create } from "zustand";
import { useAppStore } from "./app-store";
import { useToastStore } from "./toast-store";

const COLLAPSED_KEY = "manor:collapsedProjectIds";
const SIDEBAR_WIDTH_KEY = "manor:sidebarWidth";
const PORTS_HEIGHT_KEY = "manor:portsHeight";
const DEFAULT_SIDEBAR_WIDTH = 220;
const DEFAULT_PORTS_HEIGHT = 200;
export const MIN_PORTS_HEIGHT = 60;
const MAX_PORTS_HEIGHT = 500;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (raw) {
      const width = Number(raw);
      if (Number.isFinite(width) && width >= 160 && width <= 400) return width;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SIDEBAR_WIDTH;
}

function loadPortsHeight(): number {
  try {
    const raw = localStorage.getItem(PORTS_HEIGHT_KEY);
    if (raw) {
      const height = Number(raw);
      if (
        Number.isFinite(height) &&
        height >= MIN_PORTS_HEIGHT &&
        height <= MAX_PORTS_HEIGHT
      )
        return height;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PORTS_HEIGHT;
}

function loadCollapsedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return new Set();
}

function saveCollapsedIds(ids: Set<string>): void {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
}

export interface CustomCommand {
  id: string;
  name: string;
  command: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export interface PrInfo {
  number: number;
  state: string;
  title: string;
  url: string;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  checks?: {
    total: number;
    passing: number;
    failing: number;
    pending: number;
  } | null;
  unresolvedThreads?: number;
}

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
  diffStats?: DiffStats | null;
  pr?: PrInfo | null;
  linkedIssues?: LinkedIssue[];
}

export interface LinkedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface LinearAssociation {
  teamId: string;
  teamName: string;
  teamKey: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceIndex: number;
  defaultRunCommand: string | null;
  worktreePath: string | null;
  worktreeStartScript: string | null;
  worktreeTeardownScript: string | null;
  linearAssociations: LinearAssociation[];
  color: string | null;
  agentCommand: string | null;
  commands: CustomCommand[];
  themeName: string | null;
  setupComplete: boolean;
}

export type SetupStep = "prune" | "fetch" | "create-worktree" | "persist" | "switch" | "setup-script";
export type StepStatus = "pending" | "in-progress" | "done" | "error";
export type SetupProgressEvent = { step: SetupStep; status: StepStatus; message?: string };

export type ProjectUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "defaultRunCommand"
    | "worktreePath"
    | "worktreeStartScript"
    | "worktreeTeardownScript"
    | "linearAssociations"
    | "color"
    | "agentCommand"
    | "commands"
    | "themeName"
    | "setupComplete"
  >
>;

interface ProjectState {
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  portsHeight: number;
  loading: boolean;
  initialLoadDone: boolean;
  collapsedProjectIds: Set<string>;

  // Actions
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<void>;
  addProjectFromDirectory: () => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  selectProject: (index: number) => void;
  selectWorkspace: (projectId: string, workspaceIndex: number) => void;
  createWorktree: (
    projectId: string,
    name: string,
    branch?: string,
    agentCommand?: string,
    linkedIssue?: LinkedIssue,
    baseBranch?: string,
  ) => Promise<string | null>;
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => Promise<void>;
  canQuickMerge: (
    projectId: string,
    worktreePath: string,
  ) => Promise<{ canMerge: boolean; reason?: string }>;
  quickMergeWorktree: (
    projectId: string,
    worktreePath: string,
  ) => Promise<void>;
  renameWorkspace: (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => Promise<void>;
  convertMainToWorktree: (projectId: string, name: string, branch: string) => Promise<string | null>;
  reorderProjects: (orderedIds: string[]) => Promise<void>;
  reorderWorkspaces: (
    projectId: string,
    orderedPaths: string[],
  ) => Promise<void>;
  updateProject: (
    projectId: string,
    updates: ProjectUpdatableFields,
  ) => Promise<void>;
  updateWorkspaceBranch: (workspacePath: string, branch: string) => void;
  updateWorkspaceDiffStats: (
    workspacePath: string,
    stats: DiffStats | null,
  ) => void;
  updateWorkspacePr: (workspacePath: string, pr: PrInfo | null) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  setPortsHeight: (height: number) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  setProjectExpanded: (projectId: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectIndex: 0,
  sidebarVisible: true,
  sidebarWidth: loadSidebarWidth(),
  portsHeight: loadPortsHeight(),
  loading: false,
  initialLoadDone: false,
  collapsedProjectIds: loadCollapsedIds(),

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await window.electronAPI.projects.getAll();
      const selectedIndex =
        await window.electronAPI.projects.getSelectedIndex();
      set({ projects, selectedProjectIndex: selectedIndex, loading: false, initialLoadDone: true });
    } catch {
      set({ loading: false, initialLoadDone: true });
    }
  },

  addProject: async (name: string, path: string) => {
    const project = await window.electronAPI.projects.add(name, path);
    set((s) => ({
      projects: [...s.projects, project],
      selectedProjectIndex: s.projects.length,
    }));
  },

  addProjectFromDirectory: async () => {
    const selected = await window.electronAPI.dialog.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await get().addProject(name, selected);
    }
  },

  removeProject: async (projectId: string) => {
    await window.electronAPI.projects.remove(projectId);
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== projectId);
      return {
        projects,
        selectedProjectIndex: Math.min(
          s.selectedProjectIndex,
          Math.max(0, projects.length - 1),
        ),
      };
    });
  },

  selectProject: (index: number) => {
    window.electronAPI.projects.select(index);
    set({ selectedProjectIndex: index });
  },

  selectWorkspace: (projectId: string, workspaceIndex: number) => {
    window.electronAPI.projects.selectWorkspace(projectId, workspaceIndex);
    const projectIndex = get().projects.findIndex((p) => p.id === projectId);
    set((s) => ({
      selectedProjectIndex:
        projectIndex >= 0 ? projectIndex : s.selectedProjectIndex,
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, selectedWorkspaceIndex: workspaceIndex }
          : p,
      ),
    }));
    // Activate the workspace in the app store so the UI switches to it
    const project = get().projects.find((p) => p.id === projectId);
    const ws = project?.workspaces[workspaceIndex];
    if (ws) {
      useAppStore.getState().setActiveWorkspace(ws.path);
    }
  },

  createWorktree: async (
    projectId: string,
    name: string,
    branch?: string,
    agentCommand?: string,
    linkedIssue?: LinkedIssue,
    baseBranch?: string,
  ) => {
    let updated;
    try {
      updated = await window.electronAPI.projects.createWorktree(
        projectId,
        name,
        branch,
        linkedIssue,
        baseBranch,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Strip the verbose "Error invoking remote method" prefix
      const detail = message.replace(
        /^Error invoking remote method '[^']+': Error:\s*/i,
        "",
      );
      useToastStore.getState().addToast({
        id: `worktree-error-${Date.now()}`,
        message: "Failed to create workspace",
        status: "error",
        detail,
      });
      return null;
    }
    if (!updated) return null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    // Find the new workspace by name or branch.
    const branchName = branch || name;
    const newWs = updated.workspaces.find(
      (ws) => !ws.isMain && (ws.name === name || ws.branch === branchName),
    );
    const wsPath = newWs?.path ?? null;
    if (wsPath) {
      // Select the new workspace and switch to it
      const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
      if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);
      const startScript = updated.worktreeStartScript;
      const command =
        startScript && agentCommand
          ? `${startScript} && ${agentCommand}`
          : agentCommand || startScript || null;
      if (command) {
        useAppStore.getState().setPendingStartupCommand(wsPath, command);
      }
      if (command) {
        useAppStore.getState().addSession();
      }
    }
    return wsPath;
  },

  removeWorktree: async (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => {
    await window.electronAPI.projects.removeWorktree(
      projectId,
      worktreePath,
      deleteBranch,
    );
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.projects.getAll();
    set({ projects });
  },

  canQuickMerge: async (projectId: string, worktreePath: string) => {
    return window.electronAPI.projects.canQuickMerge(projectId, worktreePath);
  },

  quickMergeWorktree: async (projectId: string, worktreePath: string) => {
    await window.electronAPI.projects.quickMergeWorktree(
      projectId,
      worktreePath,
    );
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.projects.getAll();
    set({ projects });
  },

  convertMainToWorktree: async (projectId: string, name: string, branch: string) => {
    let updated;
    try {
      updated = await window.electronAPI.projects.convertMainToWorktree(projectId, name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = message.replace(/^Error invoking remote method '[^']+': Error:\s*/i, "");
      useToastStore.getState().addToast({
        id: `convert-error-${Date.now()}`,
        message: "Failed to convert to workspace",
        status: "error",
        detail,
      });
      return null;
    }
    if (!updated) return null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    // Find and select the new worktree workspace
    const newWs = updated.workspaces.find(
      (ws) => !ws.isMain && ws.branch === branch,
    );
    const wsPath = newWs?.path ?? null;
    if (wsPath) {
      const newIdx = updated.workspaces.findIndex((ws) => ws.path === wsPath);
      if (newIdx >= 0) get().selectWorkspace(projectId, newIdx);
      const startScript = updated.worktreeStartScript;
      if (startScript) {
        useAppStore.getState().setPendingStartupCommand(wsPath, startScript);
        useAppStore.getState().addSession();
      }
    }
    return wsPath;
  },

  reorderProjects: async (orderedIds: string[]) => {
    await window.electronAPI.projects.reorder(orderedIds);
    set((s) => {
      const selectedId = s.projects[s.selectedProjectIndex]?.id;
      const byId = new Map(s.projects.map((p) => [p.id, p]));
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((p): p is ProjectInfo => p != null);
      const orderedSet = new Set(orderedIds);
      for (const p of s.projects) {
        if (!orderedSet.has(p.id)) reordered.push(p);
      }
      const newSelectedIndex = selectedId
        ? Math.max(
            0,
            reordered.findIndex((p) => p.id === selectedId),
          )
        : s.selectedProjectIndex;
      return { projects: reordered, selectedProjectIndex: newSelectedIndex };
    });
  },

  reorderWorkspaces: async (projectId: string, orderedPaths: string[]) => {
    await window.electronAPI.projects.reorderWorkspaces(
      projectId,
      orderedPaths,
    );
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const byPath = new Map(p.workspaces.map((ws) => [ws.path, ws]));
        const reordered = orderedPaths
          .map((path) => byPath.get(path))
          .filter((ws): ws is WorkspaceInfo => ws != null);
        // Append any workspaces not in orderedPaths (shouldn't happen, but safe)
        const orderedSet = new Set(orderedPaths);
        for (const ws of p.workspaces) {
          if (!orderedSet.has(ws.path)) reordered.push(ws);
        }
        return { ...p, workspaces: reordered };
      }),
    }));
  },

  renameWorkspace: async (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => {
    await window.electronAPI.projects.renameWorkspace(
      projectId,
      workspacePath,
      newName,
    );
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              workspaces: p.workspaces.map((ws) =>
                ws.path === workspacePath
                  ? { ...ws, name: newName.trim() || null }
                  : ws,
              ),
            }
          : p,
      ),
    }));
  },

  updateProject: async (projectId: string, updates: ProjectUpdatableFields) => {
    // Optimistic update: apply changes immediately for instant UI feedback
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, ...updates } : p,
      ),
    }));
    const updated = await window.electronAPI.projects.update(
      projectId,
      updates,
    );
    if (updated) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
      }));
    }
  },

  updateWorkspaceBranch: (workspacePath: string, branch: string) =>
    set((s) => ({
      projects: s.projects.map((p) => {
        const wsIdx = p.workspaces.findIndex((ws) => ws.path === workspacePath);
        if (wsIdx === -1) return p;
        const ws = p.workspaces[wsIdx];
        if (ws.branch === branch) return p;
        const workspaces = [...p.workspaces];
        workspaces[wsIdx] = { ...ws, branch };
        return { ...p, workspaces };
      }),
    })),

  updateWorkspaceDiffStats: (workspacePath: string, stats: DiffStats | null) =>
    set((s) => ({
      projects: s.projects.map((p) => {
        const wsIdx = p.workspaces.findIndex((ws) => ws.path === workspacePath);
        if (wsIdx === -1) return p;
        const ws = p.workspaces[wsIdx];
        if (
          ws.diffStats?.added === stats?.added &&
          ws.diffStats?.removed === stats?.removed
        )
          return p;
        const workspaces = [...p.workspaces];
        workspaces[wsIdx] = { ...ws, diffStats: stats };
        return { ...p, workspaces };
      }),
    })),

  updateWorkspacePr: (workspacePath: string, pr: PrInfo | null) =>
    set((s) => ({
      projects: s.projects.map((p) => {
        const wsIdx = p.workspaces.findIndex((ws) => ws.path === workspacePath);
        if (wsIdx === -1) return p;
        const ws = p.workspaces[wsIdx];
        if (ws.pr?.number === pr?.number && ws.pr?.state === pr?.state)
          return p;
        const workspaces = [...p.workspaces];
        workspaces[wsIdx] = { ...ws, pr };
        return { ...p, workspaces };
      }),
    })),

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (width: number) => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    set({ sidebarWidth: width });
  },

  setPortsHeight: (height: number) => {
    const clamped = Math.max(
      MIN_PORTS_HEIGHT,
      Math.min(MAX_PORTS_HEIGHT, height),
    );
    localStorage.setItem(PORTS_HEIGHT_KEY, String(clamped));
    set({ portsHeight: clamped });
  },

  toggleProjectCollapsed: (projectId: string) =>
    set((s) => {
      const next = new Set(s.collapsedProjectIds);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      saveCollapsedIds(next);
      return { collapsedProjectIds: next };
    }),

  setProjectExpanded: (projectId: string) =>
    set((s) => {
      if (!s.collapsedProjectIds.has(projectId)) return s;
      const next = new Set(s.collapsedProjectIds);
      next.delete(projectId);
      saveCollapsedIds(next);
      return { collapsedProjectIds: next };
    }),
}));
