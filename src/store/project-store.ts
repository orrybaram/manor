import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface WorktreeInfo {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeInfo[];
  selectedWorktreeIndex: number;
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
  selectWorktree: (projectId: string, worktreeIndex: number) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
}

export const useProjectStore = create<ProjectState>((set, _get) => ({
  projects: [],
  selectedProjectIndex: 0,
  sidebarVisible: true,
  sidebarWidth: 220,
  loading: false,

  loadProjects: async () => {
    set({ loading: true });
    try {
      const projects = await invoke<ProjectInfo[]>("get_projects");
      const selectedIndex = await invoke<number>("get_selected_project_index");
      set({ projects, selectedProjectIndex: selectedIndex, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  addProject: async (name: string, path: string) => {
    const project = await invoke<ProjectInfo>("add_project", { name, path });
    set((s) => ({
      projects: [...s.projects, project],
      selectedProjectIndex: s.projects.length,
    }));
  },

  removeProject: async (projectId: string) => {
    await invoke("remove_project", { projectId });
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
    invoke("select_project", { index });
    set({ selectedProjectIndex: index });
  },

  selectWorktree: (projectId: string, worktreeIndex: number) => {
    invoke("select_worktree", { projectId, worktreeIndex });
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, selectedWorktreeIndex: worktreeIndex }
          : p
      ),
    }));
  },

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  setSidebarWidth: (width: number) => set({ sidebarWidth: width }),
}));
