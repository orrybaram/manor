import { create } from "zustand";

export interface WorkspaceInfo {
  path: string;
  branch: string;
  isMain: boolean;
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
  removeWorktree: (projectId: string, worktreePath: string) => Promise<void>;
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
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, selectedWorkspaceIndex: workspaceIndex }
          : p
      ),
    }));
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

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (width: number) => set({ sidebarWidth: width }),
}));
