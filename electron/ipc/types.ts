/**
 * `HostDeps` — the one deps object every host-side handler runs over (ADR-180
 * D8, ticket 11). `electron/bridge/handlers.ts` and
 * `electron/bridge/handlers/*` are the handler table's implementation and
 * take this as their first argument; the six modules left in `electron/ipc/`
 * — what only Electron can do — take it too, and so does every control route
 * under `electron/routes/` (ADR-182 D8). There is one shape of deps to build,
 * one place (`app-lifecycle.ts`) that builds it, and nothing in it is null.
 */
import type { BrowserWindow } from "electron";
import type { LocalBackend } from "../backend/local-backend";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LayoutStore } from "../layout/layout-store";
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

export interface HostDeps {
  /** The PRIMARY renderer window. */
  mainWindow: BrowserWindow | null;
  /** All live, non-destroyed renderer windows (primary + detached popups). */
  getRendererWindows: () => BrowserWindow[];
  /**
   * Register a detached popup window (created via `createDetachedWindow`) so it
   * is tracked for broadcast, reachable by its windowId, and known to the
   * layout store as the holder of `claim` (ADR-179 D4).
   */
  registerDetachedWindow: (
    windowId: string,
    win: BrowserWindow,
    claim: { workspacePath: string; tabId: string },
  ) => void;
  backend: LocalBackend;
  layoutPersistence: LayoutPersistence;
  /** ADR-179. The one authority for every workspace's layout. */
  layoutStore: LayoutStore;
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
