/**
 * The vocabulary every route in `electron/routes/` speaks: the dependency bag,
 * the two HTTP callbacks the listener hands down, and the `Route` shape the
 * matcher consumes.
 *
 * This module is the acyclic root of `electron/routes/`. `./index.ts` imports
 * the route modules to build its table, so nothing under `routes/` may import
 * back from `./index.ts` — the shared declarations live here instead.
 */

import type { BrowserWindow } from "electron";
import type { ProjectManager } from "../persistence";
import type { GitHubManager } from "../github";
import type { LinearManager } from "../linear";
import type { LayoutPersistence } from "../terminal-host/layout-persistence";
import type { AgentManager } from "../agent-persistence";
import type { WorkspaceBackend } from "../backend/types";
import type { NotificationStore } from "../notification-store";
import type { StatsStore } from "../stats-store";
import type { WorkspaceOps } from "../workspace-ops";
import type { PreferencesManager } from "../preferences";
import type { ThemeManager } from "../theme";
import type { PortScanner } from "../ports";
import type { RemoteControlController } from "../remote-control/controller";
import type { AgentHookServer } from "../agent-hooks";
import type { AgentStatusSignals } from "../agent-status/driver";
import type { SessionOwners } from "../backend/session-owners";

/** One buffered `console-message` from a webview's `WebContents`. */
export interface ConsoleEntry {
  timestamp: string;
  level: "log" | "warn" | "error" | "info";
  message: string;
}

/**
 * Pane→`WebContents` resolution and buffered console logs, owned by
 * `WebviewServer` (ADR-183). Structural, like `webviewServer` below, so
 * `routes/` keeps no import edge back to its host module.
 */
export interface WebviewPaneAccess {
  /** paneId → webContentsId, for `GET /webviews`. */
  registry: ReadonlyMap<string, number>;
  /** The pane's live `WebContents`, or why it can't be reached. */
  getWebContents(
    paneId: string,
  ): { wc: Electron.WebContents } | { error: string; status: number };
  /** Buffered `console-message` entries per pane, oldest first. */
  consoleLogs: ReadonlyMap<string, ConsoleEntry[]>;
}

export interface ControlDeps {
  projectManager: ProjectManager | null;
  githubManager: GitHubManager | null;
  linearManager: LinearManager | null;
  layoutPersistence: LayoutPersistence | null;
  agentManager: AgentManager | null;
  backend: WorkspaceBackend | null;
  notificationStore: NotificationStore | null;
  statsStore: StatsStore | null;
  /**
   * Workspace create / remove / quick-merge with their side effects (ADR-203).
   * The same instance IPC uses, so CLI / MCP workspaces reach stats too.
   */
  workspaceOps: WorkspaceOps | null;
  preferencesManager: PreferencesManager | null;
  themeManager: ThemeManager | null;
  portScanner: PortScanner | null;
  remoteControl: RemoteControlController | null;
  agentHookServer: AgentHookServer | null;
  /**
   * The Status reconciler's driver (ADR-184): routes that change an Agent's
   * lifecycle send it `user` signals instead of writing status. Optional so
   * control-deps bags built without it (tests, older call sites) still type.
   */
  agentStatus?: AgentStatusSignals | null;
  /**
   * The HTTP server serving this very request, reported by `GET /processes`
   * alongside the other internal servers. Structural rather than the
   * `WebviewServer` class so `routes/` keeps no import edge back to its own
   * host module.
   */
  webviewServer: { serverPort: number | null } | null;
  /** Pane inspection routes' access to `WebviewServer`'s pane registry. */
  webviewPanes: WebviewPaneAccess | null;
  /**
   * The URL to actually load for a `navigate` in `paneId`'s webview: itself,
   * or rewritten through the pane's host's port forward for a remote
   * workspace (ADR-178 §5, ADR-183). Main-owned so `navigate` never races a
   * setter installed as a side effect of another module's registration.
   */
  resolvePaneUrl: ((paneId: string, url: string) => Promise<string>) | null;
  getRendererWindows: (() => BrowserWindow[]) | null;
  /**
   * Set per request when it was relayed from a remote host's `manor` CLI
   * (ADR-189 §2): the host it came from. Routes that infer "the caller's
   * project" from a path use it to only consider that host's projects, since
   * the same path can exist on this machine too. Unset for local callers.
   */
  callerHostId?: string;
  /**
   * Which host owns each terminal session (ADR-160 §6, ADR-191 §4). `GET
   * /context` falls back to this — the host of the calling pane — for a
   * local caller with no `callerHostId`, since a pane ADR-183 moved to
   * another host is still local to *this* process.
   */
  sessionOwners: SessionOwners | null;
}

export type Json = (status: number, body: unknown) => void;
export type ReadBody = () => Promise<Record<string, unknown>>;

/** Everything a route handler is given. `params` are already decoded. */
export interface RouteContext {
  deps: ControlDeps;
  params: Record<string, string>;
  url: URL;
  json: Json;
  readBody: ReadBody;
}

/**
 * One row of the route table. `path` is a `/`-delimited pattern whose `:name`
 * segments capture into `RouteContext.params`.
 *
 * Handlers return `void`, not `boolean`: a handler that ran *is* the response.
 * The dispatcher owns the `true`/`false` the HTTP listener switches on.
 */
export interface Route {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: (ctx: RouteContext) => Promise<void>;
}
