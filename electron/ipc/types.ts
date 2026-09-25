import type { BrowserWindow } from "electron";
import type { WorkspaceBackend } from "../backend/types";
import type { BackendRegistry } from "../backend/registry";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { ProjectManager } from "../persistence";
import type { ThemeManager } from "../theme";
import type { PortScanner } from "../ports";
import type { BranchWatcher } from "../branch-watcher";
import type { DiffWatcher } from "../diff-watcher";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { AgentHookServer } from "../agent-hooks";
import type { AgentManager } from "../agent-persistence";
import type { NotificationStore } from "../notification-store";
import type { StatsStore } from "../stats-store";
import type { PreferencesManager } from "../preferences";
import type { KeybindingsManager } from "../keybindings";
import type { WebviewServer } from "../webview-server";
import type { PrewarmManager } from "../prewarm-manager";
import type { RemoteControlController } from "../remote-control/controller";
import type { AppMenuController } from "../app-menu";

export interface WorkspaceMeta {
  path: string;
  projectName: string | null;
  branch: string | null;
  isMain: boolean;
  /** When false, this workspace's ports get no `.localhost` preview hostname. */
  portlessEnabled: boolean;
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
  /** Routes each pane, cwd and pid to its host (`RoutedBackend`). */
  backend: WorkspaceBackend;
  /** Every host and its connection status (ADR-160). */
  backendRegistry: BackendRegistry;
  layoutPersistence: LayoutPersistence;
  projectManager: ProjectManager;
  themeManager: ThemeManager;
  portScanner: PortScanner;
  branchWatcher: BranchWatcher;
  diffWatcher: DiffWatcher;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  agentHookServer: AgentHookServer;
  agentManager: AgentManager;
  /** ADR-162's durable notification log. */
  notificationStore: NotificationStore;
  /** ADR-168 usage stats. */
  statsStore: StatsStore;
  preferencesManager: PreferencesManager;
  keybindingsManager: KeybindingsManager;
  paneContextMap: Map<
    string,
    {
      projectId: string;
      projectName: string;
      workspacePath: string;
      agentCommand: string | null;
    }
  >;
  unseenRespondedAgents: Set<string>;
  unseenInputAgents: Set<string>;
  webviewServer: WebviewServer;
  workspaceMeta: WorkspaceMeta[];
  prewarmManager: PrewarmManager;
  /** ADR-161. Off until the user enables it; see the controller header. */
  remoteControl: RemoteControlController;
  /** ADR-170. The native application menu controller. */
  appMenu: AppMenuController;
}
