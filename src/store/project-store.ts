import { create } from "zustand";
import { useAppStore } from "./app-store";
import { useToastStore } from "./toast-store";

const COLLAPSED_KEY = "manor:collapsedProjectIds";
const SIDEBAR_WIDTH_KEY = "manor:sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 220;

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

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
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
}

export type ProjectUpdatableFields = Partial<
  Pick<
    ProjectInfo,
    | "name"
    | "defaultRunCommand"
    | "worktreePath"
    | "worktreeStartScript"
    | "worktreeTeardownScript"
    | "linearAssociations"
  >
>;

interface ProjectState {
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  loading: boolean;
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
  ) => Promise<string | null>;
  removeWorktree: (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => Promise<void>;
  renameWorkspace: (
    projectId: string,
    workspacePath: string,
    newName: string,
  ) => Promise<void>;
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
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  setProjectExpanded: (projectId: string) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectIndex: 0,
  sidebarVisible: true,
  sidebarWidth: loadSidebarWidth(),
  loading: false,
  collapsedProjectIds: loadCollapsedIds(),

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await window.electronAPI.getProjects();
      const selectedIndex = await window.electronAPI.getSelectedProjectIndex();
      set({ projects, selectedProjectIndex: selectedIndex, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addProject: async (name: string, path: string) => {
    const project = await window.electronAPI.addProject(name, path);
    set((s) => ({
      projects: [...s.projects, project],
      selectedProjectIndex: s.projects.length,
    }));
  },

  addProjectFromDirectory: async () => {
    const selected = await window.electronAPI.openDirectory();
    if (selected) {
      const name = selected.split("/").pop() || "Untitled";
      await get().addProject(name, selected);
    }
  },

  removeProject: async (projectId: string) => {
    await window.electronAPI.removeProject(projectId);
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
    window.electronAPI.selectProject(index);
    set({ selectedProjectIndex: index });
  },

  selectWorkspace: (projectId: string, workspaceIndex: number) => {
    window.electronAPI.selectWorkspace(projectId, workspaceIndex);
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
  },

  createWorktree: async (projectId: string, name: string, branch?: string) => {
    let updated;
    try {
      updated = await window.electronAPI.createWorktree(
        projectId,
        name,
        branch,
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
      if (updated.worktreeStartScript) {
        useAppStore
          .getState()
          .setPendingStartupCommand(wsPath, updated.worktreeStartScript);
      }
      useAppStore.getState().setActiveWorkspace(wsPath);
    }
    return wsPath;
  },

  removeWorktree: async (
    projectId: string,
    worktreePath: string,
    deleteBranch?: boolean,
  ) => {
    await window.electronAPI.removeWorktree(
      projectId,
      worktreePath,
      deleteBranch,
    );
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.getProjects();
    set({ projects });
  },

  reorderProjects: async (orderedIds: string[]) => {
    await window.electronAPI.reorderProjects(orderedIds);
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
    await window.electronAPI.reorderWorkspaces(projectId, orderedPaths);
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
    await window.electronAPI.renameWorkspace(projectId, workspacePath, newName);
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
    const updated = await window.electronAPI.updateProject(projectId, updates);
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

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (width: number) => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    set({ sidebarWidth: width });
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
