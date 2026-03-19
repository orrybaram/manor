import { create } from "zustand";

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
  name: string | null;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  workspaces: WorkspaceInfo[];
  selectedWorkspaceIndex: number;
  setupScript: string | null;
  teardownScript: string | null;
  defaultRunCommand: string | null;
}

interface ProjectState {
  projects: ProjectInfo[];
  selectedProjectIndex: number;
  sidebarVisible: boolean;
  sidebarWidth: number;
  loading: boolean;

  // Actions
  loadProjects: () => Promise<void>;
  addProject: (name: string, path: string) => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  selectProject: (index: number) => void;
  selectWorkspace: (projectId: string, workspaceIndex: number) => void;
  createWorktree: (projectId: string, name: string, branch?: string) => Promise<string | null>;
  removeWorktree: (projectId: string, worktreePath: string) => Promise<void>;
  renameWorkspace: (projectId: string, workspacePath: string, newName: string) => Promise<void>;
  reorderWorkspaces: (projectId: string, orderedPaths: string[]) => void;
  updateProject: (projectId: string, updates: Partial<Pick<ProjectInfo, "name" | "setupScript" | "teardownScript" | "defaultRunCommand">>) => Promise<void>;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  selectedProjectIndex: 0,
  sidebarVisible: true,
  sidebarWidth: 220,
  loading: false,

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

  removeProject: async (projectId: string) => {
    await window.electronAPI.removeProject(projectId);
    set((s) => {
      const projects = s.projects.filter((p) => p.id !== projectId);
      return {
        projects,
        selectedProjectIndex: Math.min(
          s.selectedProjectIndex,
          Math.max(0, projects.length - 1)
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
      selectedProjectIndex: projectIndex >= 0 ? projectIndex : s.selectedProjectIndex,
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, selectedWorkspaceIndex: workspaceIndex }
          : { ...p, selectedWorkspaceIndex: -1 }
      ),
    }));
  },

  createWorktree: async (projectId: string, name: string, branch?: string) => {
    const updated = await window.electronAPI.createWorktree(projectId, name, branch);
    if (!updated) return null;
    set((s) => ({
      projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
    }));
    // Return the path of the new workspace (last non-main workspace)
    const newWs = updated.workspaces.find((ws) => !ws.isMain && ws.name === name);
    return newWs?.path ?? null;
  },

  removeWorktree: async (projectId: string, worktreePath: string) => {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return;
    await window.electronAPI.removeWorktree(project.path, worktreePath);
    // Refresh projects to get updated worktree list
    const projects = await window.electronAPI.getProjects();
    set({ projects });
  },

  reorderWorkspaces: (projectId: string, orderedPaths: string[]) => {
    window.electronAPI.reorderWorkspaces(projectId, orderedPaths);
    set((s) => ({
      projects: s.projects.map((p) => {
        if (p.id !== projectId) return p;
        const byPath = new Map(p.workspaces.map((ws) => [ws.path, ws]));
        const reordered = orderedPaths
          .map((path) => byPath.get(path))
          .filter((ws): ws is WorkspaceInfo => ws != null);
        // Append any workspaces not in orderedPaths (shouldn't happen, but safe)
        for (const ws of p.workspaces) {
          if (!orderedPaths.includes(ws.path)) reordered.push(ws);
        }
        return { ...p, workspaces: reordered };
      }),
    }));
  },

  renameWorkspace: async (projectId: string, workspacePath: string, newName: string) => {
    await window.electronAPI.renameWorkspace(projectId, workspacePath, newName);
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              workspaces: p.workspaces.map((ws) =>
                ws.path === workspacePath
                  ? { ...ws, name: newName.trim() || null }
                  : ws
              ),
            }
          : p
      ),
    }));
  },

  updateProject: async (projectId: string, updates: Partial<Pick<ProjectInfo, "name" | "setupScript" | "teardownScript" | "defaultRunCommand">>) => {
    const updated = await window.electronAPI.updateProject(projectId, updates);
    if (updated) {
      set((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? updated : p)),
      }));
    }
  },

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (width: number) => set({ sidebarWidth: width }),
}));
