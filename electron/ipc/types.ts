import type { BrowserWindow } from "electron";
import type { LocalBackend } from "../backend/local-backend";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { ProjectManager } from "../persistence";
import type { ThemeManager } from "../theme";
import type { PortScanner } from "../ports";
import type { BranchWatcher } from "../branch-watcher";
import type { DiffWatcher } from "../diff-watcher";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { AgentHookServer } from "../agent-hooks";
import type { TaskManager } from "../task-persistence";
import type { PreferencesManager } from "../preferences";
import type { KeybindingsManager } from "../keybindings";
import type { WebviewServer } from "../webview-server";
import type { PrewarmManager } from "../prewarm-manager";

export interface WorkspaceMeta {
  path: string;
  projectName: string | null;
  branch: string | null;
  isMain: boolean;
}

export interface IpcDeps {
  /** The PRIMARY renderer window. */
  mainWindow: BrowserWindow | null;
  /** All live, non-destroyed renderer windows (primary + detached popups). */
  getRendererWindows: () => BrowserWindow[];
  /**
   * Register a detached popup window (created via `createDetachedWindow`) so it
   * is tracked for broadcast and reachable by its windowId.
   */
  registerDetachedWindow: (windowId: string, win: BrowserWindow) => void;
  backend: LocalBackend;
  layoutPersistence: LayoutPersistence;
  projectManager: ProjectManager;
  themeManager: ThemeManager;
  portScanner: PortScanner;
  branchWatcher: BranchWatcher;
  diffWatcher: DiffWatcher;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  agentHookServer: AgentHookServer;
  taskManager: TaskManager;
  preferencesManager: PreferencesManager;
  keybindingsManager: KeybindingsManager;
  paneContextMap: Map<
    string,
    { projectId: string; projectName: string; workspacePath: string; agentCommand: string | null }
  >;
  unseenRespondedTasks: Set<string>;
  unseenInputTasks: Set<string>;
  webviewServer: WebviewServer;
  workspaceMeta: WorkspaceMeta[];
  prewarmManager: PrewarmManager;
}
