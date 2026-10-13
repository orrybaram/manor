/**
 * `HostDeps` — the one deps object every host-side handler runs over (ADR-180
 * D8, ticket 11). `electron/bridge/handlers.ts` and
 * `electron/bridge/handlers/*` are the handler table's implementation and
 * take this as their first argument; the six modules left in `electron/ipc/`
 * — what only Electron can do — take it too, and so does every control route
 * under `electron/routes/` (ADR-182 D8). There is one shape of deps to build,
 * one place (`app-lifecycle.ts`) that builds it, and nothing in it is null
 * (what a server without a desktop or remote hosts leaves out aside).
 *
 * It is two halves (ADR-227 D1). `ServerDeps` is window-free: what a Manor
 * server has wherever it runs, and what the shared handlers
 * (`SERVER_METHODS`) are typed over. `DesktopDeps` is what only the desktop
 * adds — its windows, its menu, its webview server. `HostDeps` is both.
 */
import type { HostServerSync } from "../backend/host-server-sync";
import type { HostRouting } from "../server/host-routing";
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
import type { JevClient } from "../jev";
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
import type { SessionOwners } from "../backend/session-owners";
import type { HostStatus } from "../backend/host-connection";
import type { WebviewPaneAccess } from "../routes/types";
import type { ChatMirror } from "../chat-mirror/mirror";
import type { AppCommandResult } from "../renderer-bridge";
import type { UnseenAgents } from "../agent-status/unseen-agents";
import type { ServerNotifier } from "../notifications";

/** A workspace as the renderer describes it for portless hostnames. */
export interface WorkspaceMeta extends PortlessWorkspace {
  /** The workspace's project's host (ADR-191). */
  hostId: string;
  /** When false, this workspace's ports get no `.localhost` preview hostname. */
  portlessEnabled: boolean;
}

export interface ServerDeps {
  /** Routes each pane, cwd and pid to its host (`RoutedBackend`). */
  backend: RoutedBackend;
  /** Every host and its connection status (ADR-160). */
  backendRegistry: BackendRegistry;
  /**
   * What is pushed to each remote host's server, and its push endpoints.
   * Absent on a server with no remote hosts (`Platform.remoteHosts`).
   */
  hostServerSync?: HostServerSync;
  /**
   * The desktop as a client of each adopted host's server (ADR-227 D4): the
   * proxies' layouts and agents the shared reads merge in. Absent on a
   * server with no remote hosts.
   */
  hostRouting?: HostRouting;
  /** A pane's session owner, if any host has claimed it (ADR-191 §5). */
  getPaneHostId: PaneHostLookup;
  layoutPersistence: LayoutPersistence;
  /** ADR-179. The one authority for every workspace's layout. */
  layoutStore: LayoutStore;
  projectManager: ProjectManager;
  themeManager: ThemeManager;
  portScanner: PortScanner;
  /**
   * Port forwards to remote projects' dev servers (ADR-178 §5). Absent on a
   * server with no remote hosts.
   */
  remoteForwards?: RemoteForwards;
  /**
   * Turns a URL opened in a remote host's context into the one to load
   * (ADR-178 §5). Built once in `app-lifecycle.ts` alongside `paneHosts` so
   * `RouteDeps.resolvePaneUrl` exists before any IPC module registers
   * (ADR-183) — `ports:resolveUrl` uses the same instance.
   */
  remoteUrlResolver: RemoteUrlResolver;
  /** paneId → the remote host its workspace lives on (ADR-178 §5, ADR-183). */
  paneHosts: Map<string, string>;
  branchWatcher: BranchWatcher;
  diffWatcher: DiffWatcher;
  githubManager: GitHubManager;
  linearManager: LinearManager;
  jevClient: JevClient;
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
  /**
   * ADR-215. Each pane's Claude transcript, mirrored for the phone's chat
   * view; the `chat` namespace reads and answers through it.
   */
  chatMirror: ChatMirror;
  /** ADR-162's durable notification log. */
  notificationStore: NotificationStore;
  /** ADR-168 usage stats. */
  statsStore: StatsStore;
  /**
   * Workspace create / remove / quick-merge with their side effects (ADR-203).
   * The same instance as `RouteDeps.workspaceOps`.
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
  /** Which agents the user has not looked at since they responded (ADR-227 D1). */
  unseen: UnseenAgents;
  /**
   * Notification state and side effects (ADR-227 D1): the agent broadcast, the
   * dock badge, the log. The desktop fills in a `Notifier`.
   */
  notifier: ServerNotifier;
  /**
   * Which host owns each terminal session (ADR-160 §6, ADR-191 §4) —
   * `backendRegistry.sessions`. `GET /context` falls back to it for a local
   * caller with no `callerHostId`.
   */
  sessionOwners: SessionOwners;
  /** A host's connection status, or undefined for one never registered. */
  hostStatus: (hostId: string) => HostStatus | undefined;
  workspaceMeta: WorkspaceMeta[];
  prewarmManager: PrewarmManager;
  /** ADR-161. Off until the user enables it; see the controller header. */
  remoteControl: RemoteControlController;
  /**
   * Plays a notification sound by name (`preferences.playSound`). The desktop
   * fills it in; a server with no speaker leaves it out and the call is a
   * no-op.
   */
  playSound?: (soundName: string | false) => void;
  /**
   * Settles a pending `appCommands.command` with the renderer's answer
   * (`appCommands.result`). Only the desktop sends app commands, so only it
   * fills this in.
   */
  appCommandResult?: (result: AppCommandResult) => void;
}

/**
 * The `ServerDeps` every server builds the same way, in `createManorServer`
 * (ADR-227 D1): what a host server has of them. A shared handler the host
 * table lists declares this rather than `ServerDeps`, which also names what
 * only the desktop composes (remote control, Jev, prewarm, the watchers).
 */
export type SharedDeps = Pick<
  ServerDeps,
  | "backend"
  | "backendRegistry"
  | "getPaneHostId"
  | "layoutPersistence"
  | "layoutStore"
  | "projectManager"
  | "themeManager"
  | "portScanner"
  | "githubManager"
  | "linearManager"
  | "agentHookServer"
  | "agentManager"
  | "agentStatus"
  | "chatMirror"
  | "notificationStore"
  | "statsStore"
  | "workspaceOps"
  | "agentActivityStore"
  | "preferencesManager"
  | "keybindingsManager"
  | "paneContextMap"
  | "unseen"
  | "notifier"
  | "sessionOwners"
  | "hostStatus"
  | "hostRouting"
  | "playSound"
  | "appCommandResult"
>;

/**
 * What only the desktop has: renderer windows, the app menu and the webview
 * server. Desktop-only handlers (`DESKTOP_METHODS`) and the IPC modules read
 * these; nothing in `SERVER_METHODS` may.
 */
export interface DesktopDeps {
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
  webviewServer: WebviewServer;
  /** Pane inspection routes' access to `WebviewServer`'s pane registry. */
  webviewPanes: WebviewPaneAccess;
  /**
   * The URL to actually load for a `navigate` in `paneId`'s webview: itself,
   * or rewritten through the pane's host's port forward for a remote
   * workspace (ADR-178 §5, ADR-183).
   */
  resolvePaneUrl: (paneId: string, url: string) => Promise<string>;
  /** ADR-170. The native application menu controller. */
  appMenu: AppMenuController;
  /** The desktop always has remote hosts, so always these (`ServerDeps`). */
  hostServerSync: HostServerSync;
  remoteForwards: RemoteForwards;
}

export type HostDeps = ServerDeps & DesktopDeps;
