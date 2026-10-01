/**
 * `IpcDeps` — the one deps object every host-side handler runs over (ADR-180
 * D8, ticket 11). `electron/bridge/handlers.ts` and
 * `electron/bridge/handlers/*` are the handler table's implementation and
 * take this as their first argument; the six modules left in `electron/ipc/`
 * — what only Electron can do — take it too, so there has only ever been one
 * shape of deps to build and one place (`app-lifecycle.ts`) that builds it.
 */
import type { BrowserWindow } from "electron";
import type { RoutedBackend } from "../backend/routed-backend";
import type { BackendRegistry } from "../backend/registry";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { LayoutStore } from "../layout/layout-store";
import type { ProjectManager } from "../persistence";
import type { ThemeManager } from "../theme";
import type { PortScanner } from "../ports";
import type { RemoteForwards, RemoteUrlResolver } from "../remote-forwards";
import type { BranchWatcher } from "../branch-watcher";
import type { DiffWatcher } from "../diff-watcher";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { AgentHookServer } from "../agent-hooks";
import type { AgentManager, PaneHostLookup } from "../agent-persistence";
import type { AgentStatusDriver } from "../agent-status/driver";
import type { NotificationStore } from "../notification-store";
import type { StatsStore } from "../stats-store";
import type { WorkspaceOps } from "../workspace-ops";
import type { AgentActivityStore } from "../agent-activity-store";
import type { PreferencesManager } from "../preferences";
import type { KeybindingsManager } from "../keybindings";
import type { WebviewServer } from "../webview-server";
import type { PrewarmManager } from "../prewarm-manager";
import type { RemoteControlController } from "../remote-control/controller";
import type { AppMenuController } from "../app-menu";
import type { PortlessWorkspace } from "../../src/lib/portless-hostname";

/** A workspace as the renderer describes it for portless hostnames. */
export interface WorkspaceMeta extends PortlessWorkspace {
  /** The workspace's project's host (ADR-191). */
  hostId: string;
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
  backend: RoutedBackend;
  /** Every host and its connection status (ADR-160). */
  backendRegistry: BackendRegistry;
  /** A pane's session owner, if any host has claimed it (ADR-191 §5). */
  getPaneHostId: PaneHostLookup;
  layoutPersistence: LayoutPersistence;
  /** ADR-179. The one authority for every workspace's layout. */
  layoutStore: LayoutStore;
  projectManager: ProjectManager;
  themeManager: ThemeManager;
  portScanner: PortScanner;
  /** Port forwards to remote projects' dev servers (ADR-178 §5). */
  remoteForwards: RemoteForwards;
  /**
   * Turns a URL opened in a remote host's context into the one to load
   * (ADR-178 §5). Built once in `app-lifecycle.ts` alongside `paneHosts` so
   * `ControlDeps.resolvePaneUrl` exists before any IPC module registers
   * (ADR-183) — `ports:resolveUrl` uses the same instance.
   */
  remoteUrlResolver: RemoteUrlResolver;
  /** paneId → the remote host its workspace lives on (ADR-178 §5, ADR-183). */
  paneHosts: Map<string, string>;
  branchWatcher: BranchWatcher;
  diffWatcher: DiffWatcher;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  agentHookServer: AgentHookServer;
  agentManager: AgentManager;
  /**
   * The Status reconciler's driver (ADR-184). User actions that change an
   * Agent's lifecycle enter it as `user` signals; handlers never write status.
   */
  agentStatus: Pick<
    AgentStatusDriver,
    "signal" | "getPaneState" | "getAllPaneStatuses" | "isPaneLossExpected"
  >;
  /** ADR-162's durable notification log. */
  notificationStore: NotificationStore;
  /** ADR-168 usage stats. */
  statsStore: StatsStore;
  /**
   * Workspace create / remove / quick-merge with their side effects (ADR-203).
   * The same instance as `ControlDeps.workspaceOps`.
   */
  workspaceOps: WorkspaceOps;
  /** ADR-199 persistent Agent activity history. */
  agentActivityStore: AgentActivityStore;
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
