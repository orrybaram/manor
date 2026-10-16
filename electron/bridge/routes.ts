/**
 * Which server answers each routed method (ADR-228 D1): the route rules as
 * data, readable from the renderer.
 *
 * The tables in `./handlers/` declare each method's `route`, and that is what
 * the desktop's `forward` dispatches on. This manifest is the same fact for
 * the renderer's router, which may not import the tables, and for
 * `HostRouting`. The surface test (`./__tests__/routes-surface.test.ts`) fails
 * if a table and this manifest disagree, or if a method of a routed namespace
 * is missing here. Which is why this file imports nothing: it is read from the
 * main process and from a browser bundle, the same as `./local-only.ts`.
 */

/**
 * Which host a call is for, read off one of its arguments (ADR-227 D4).
 *
 * - `project`: a project id — the host the project lives on.
 * - `workspaceKey`: a workspace key (`<hostId>:<path>`, or a bare local path).
 * - `pane`: a pane id — the host whose layout holds the pane.
 * - `ghRepo`: a `GhRepo` (`{ path, hostId }`) — its `hostId`.
 * - `host`: a host id, or null/absent for the desktop's own.
 * - `agent`: an agent id — the host whose server holds the agent.
 *
 * On the desktop, a call whose argument names a remote host is answered by
 * that host's server, through its `HostProxy` (`BridgeServer`'s `forward`);
 * every other call, and every call on a host server, runs here.
 */
export interface HostRule {
  by: "project" | "workspaceKey" | "pane" | "ghRepo" | "agent" | "host";
  /** Which wire argument names the target. */
  arg: number;
  /**
   * For a `pane` rule: an options argument whose `hostId` names the host
   * when no layout places the pane yet — a session created for a tab that
   * was added a moment ago (`pty.create`'s `{ hostId }`).
   */
  hostOpt?: number;
}

/**
 * A call tied to no path, answered by whichever server holds the user's
 * delegated credential for `provider` (ADR-228 D10): the renderer's router
 * picks it per call (`src/bridge/linear-servers.ts`). Main's `HostRouting`
 * treats it as local: the desktop's own server holds the token.
 */
export interface DelegatedRule {
  by: "delegated";
  provider: "linear";
}

/** How a routed method finds its server. */
export type RouteRule = HostRule | DelegatedRule;

/**
 * Answered here whatever host it touches: a merged read, or a write that
 * fans out to each host itself (`ProjectManager`'s groups). The surface
 * test asks every method of a routed namespace to say one or the other.
 */
export const LOCAL_ROUTE = "local";

/** A path-free call on `provider`'s delegated credential. */
export function delegated(provider: DelegatedRule["provider"]): DelegatedRule {
  return { by: "delegated", provider };
}

/** A project id at `arg`. */
export function byProject(arg: number): HostRule {
  return { by: "project", arg };
}

/** A workspace key at `arg`. */
export function byWorkspaceKey(arg: number): HostRule {
  return { by: "workspaceKey", arg };
}

/**
 * A pane id at `arg`; `hostOpt`, when given, is the options argument whose
 * `hostId` names the host of a pane no layout holds yet.
 */
export function byPane(arg: number, hostOpt?: number): HostRule {
  return hostOpt === undefined ? { by: "pane", arg } : { by: "pane", arg, hostOpt };
}

/** A `GhRepo` at `arg`. */
export function byGhRepo(arg: number): HostRule {
  return { by: "ghRepo", arg };
}

/** A host id at `arg`; an absent one stays on this machine. */
export function byHost(arg: number): HostRule {
  return { by: "host", arg };
}

/** An agent id at `arg`. */
export function byAgent(arg: number): HostRule {
  return { by: "agent", arg };
}

/**
 * `ns.method` → how a call is answered:
 *
 * - a `RouteRule`: by the host the named argument points at;
 * - `"merge"`: a read answered from every reachable server and merged;
 * - `"split"`: a list of workspaces to watch, each server sent the ones it
 *   answers for (ADR-230 D6), and its events merged as a `"merge"`'s are;
 * - `"home"`: by the caller's own server, whatever host it touches.
 *
 * On a table, `"merge"`, `"split"` and `"home"` are all `LOCAL_ROUTE`.
 */
export const ROUTES: Record<string, RouteRule | "merge" | "split" | "home"> = {
  // A remote pane's terminal is its host server's (ADR-228 D5): a desktop
  // window's own bridge to it, or main forwarding for a caller that holds
  // only the desktop. A new pane's create and reset name its host.
  "pty.create": byPane(0, 4),
  "pty.attach": byPane(0),
  "pty.reset": byPane(0, 4),
  "pty.write": byPane(0),
  "pty.resize": byPane(0),
  "pty.claimWinsize": byPane(0),
  "pty.close": byPane(0),
  "pty.detach": byPane(0),

  "chat.getHistory": byPane(0),
  "chat.getTaskHistory": byPane(0),
  "chat.getCommands": byPane(0),
  "chat.send": byPane(0),
  "chat.interrupt": byPane(0),
  "chat.key": byPane(0),
  "chat.answer": byPane(0),

  "layout.getAll": "merge",
  "layout.getLastActive": "merge",
  "layout.apply": byWorkspaceKey(0),
  "layout.setPaneTitle": byPane(0),
  "layout.setPendingCommand": byPane(0),
  // A viewport report is a window's, and a claim is desktop-window state
  // the desktop's `LayoutStore` keeps (D7): a host server has no windows.
  "layout.reportViewport": "home",

  "projects.getAll": "merge",
  "projects.getSelectedIndex": "home",
  "projects.select": "home",
  "projects.selectWorkspace": "home",
  "projects.add": "home",
  "projects.remove": "home",
  "projects.removeWorktree": byProject(0),
  "projects.canQuickMerge": byProject(0),
  "projects.quickMergeWorktree": byProject(0),
  "projects.createWorktree": byProject(0),
  "projects.convertMainToWorktree": byProject(0),
  "projects.listRemoteBranches": byProject(0),
  "projects.listLocalBranches": byProject(0),
  "projects.renameWorkspace": byProject(0),
  "projects.setWorkspaceHidden": byProject(0),
  "projects.createWorkspaceFolder": byProject(0),
  "projects.setFolderParent": byProject(0),
  "projects.renameWorkspaceFolder": byProject(0),
  "projects.deleteWorkspaceFolder": byProject(0),
  "projects.setWorkspaceFolder": byProject(0),
  "projects.reorderWorkspaces": byProject(0),
  "projects.reorder": "home",
  "projects.update": "home",
  "projects.getRemote": "merge",
  "projects.clone": "home",
  "projects.moveToHost": "home",
  "projects.transfer": "home",
  "projects.getOriginUrl": "home",
  "projects.pathExists": "home",
  "projects.switchHost": "home",
  "projects.link": "home",
  "projects.unlink": "home",
  "projects.unlinkGroup": "home",
  "projects.updateGroup": "home",
  "projects.setGroupLastUsedHost": "home",
  "projects.suggestLinks": "home",
  "projects.dismissLinkSuggestion": "home",
  "projects.autoJoin": "home",
  "projects.keepSeparate": "home",
  "projects.undoAutoJoin": "home",

  "agents.getAll": "merge",
  "agents.get": "merge",
  "agents.getActive": "merge",
  "agents.getRecent": "merge",
  "agents.getUnseen": "merge",
  "agents.getPaneStatuses": "merge",
  "agents.consumePruneNotice": "home",
  "agents.buildResumeCommand": "home",
  "agents.setPaneContext": byPane(0),
  "agents.update": byAgent(0),
  "agents.delete": byAgent(0),
  "agents.markSeen": byAgent(0),
  "agents.markResumed": byAgent(0),
  "agents.reconcileStale": "home",

  "github.getPrsForBranches": byGhRepo(0),
  "github.listRepos": "home",
  "github.checkStatus": byHost(0),
  "github.getViewerName": "home",
  "github.getMyIssues": byGhRepo(0),
  "github.getAllIssues": byGhRepo(0),
  "github.getIssueDetail": byGhRepo(0),
  "github.proxyImage": "home",
  "github.assignIssue": byGhRepo(0),
  "github.closeIssue": byGhRepo(0),
  "github.createIssue": "home",
  "github.uploadFeedbackImages": "home",

  // The path-free methods ride the user's delegated token, and the router
  // picks the server per call (D10). `isConnected` is each server's own.
  "linear.connect": "home",
  "linear.isConnected": "home",
  "linear.disconnect": "home",
  "linear.getViewer": delegated("linear"),
  "linear.getTeams": delegated("linear"),
  "linear.getMyIssues": delegated("linear"),
  "linear.getIssueDetail": delegated("linear"),
  "linear.getAllIssues": delegated("linear"),
  "linear.proxyImage": delegated("linear"),
  "linear.autoMatch": delegated("linear"),
  "linear.startIssue": delegated("linear"),
  "linear.closeIssue": delegated("linear"),
  "linear.linkIssueToWorkspace": byProject(0),
  "linear.unlinkIssueFromWorkspace": byProject(0),
  "linear.associateProject": byProject(0),

  // Waking and stopping a box is the desktop's that lists it: it holds the
  // provider (ADR-229 D1). A phone wakes a host through home (D7).
  "hosts.wake": "home",
  "hosts.stop": "home",
  // Recipes live on the desktop that runs them (ADR-229 D2).
  "hosts.addRecipeHost": "home",
  // Templates write into this desktop's recipes directory (ADR-229 D8).
  "hosts.createRecipe": "home",
  "hosts.listTemplates": "home",
  "hosts.createCustomRecipe": "home",
  // Removing a host is the desktop's that lists it (ADR-229 D8).
  "hosts.remove": "home",
  "hosts.projectsOnHost": "home",
  // Run through the host's transport, which the desktop holds (ADR-229 D4).
  "hosts.setSupervised": "home",
  // Likewise: `manor-host secrets encrypt` through the transport (ADR-236 D7).
  "hosts.encryptKeys": "home",

  // Each server watches the workspaces it answers for (ADR-230 D6); a
  // desktop window alone still hands its whole list to its own server,
  // which polls remote hosts through their backends.
  "branches.start": "split",
  "branches.stop": "split",
  "diffs.start": "split",
  "diffs.stop": "split",
};

/**
 * Routed calls that never wake a sleeping host (ADR-229 D1), beyond the
 * reads `wakesHost` already spares: what a viewer does to its own view of
 * a pane, a keystroke into one (its pane's attach is what wakes the host),
 * and bookkeeping on what the user has seen.
 */
const NEVER_WAKES: ReadonlySet<string> = new Set([
  "pty.write",
  "pty.resize",
  "pty.claimWinsize",
  "pty.detach",
  "pty.close",
  "agents.markSeen",
  "agents.setPaneContext",
]);

/**
 * Whether routed call `ns.method` means to use its host, so that a sleeping
 * host is woken for it before it is sent (ADR-229 D1): opening a pane,
 * creating a workspace, launching an agent — any write. Reads never wake
 * (`get…`, `list…`, `can…`, `is…`, `check…`): a poller must not start a box
 * the user put to sleep. Main's `HostRouting` and the renderer's router ask
 * the same question.
 */
export function wakesHost(ns: string, method: string): boolean {
  if (NEVER_WAKES.has(`${ns}.${method}`)) return false;
  return !/^(get|list|can|is|check)[A-Z]/.test(method);
}

/** Where a call that may decline to wake its host carries its options. */
const WAKE_OPTION_ARG: Readonly<Record<string, number>> = {
  "pty.create": 4,
  "pty.attach": 1,
};

/**
 * Whether routed call `ns.method` says it is not one the user meant
 * (`wake: false`, ADR-230 D3): a pane restored at launch, on its first
 * mount. A sleeping host is then left asleep and the call answered as for a
 * host that is away. Main's `HostRouting` and the renderer's router ask the
 * same question.
 */
export function declinesWake(ns: string, method: string, args: readonly unknown[]): boolean {
  const at = WAKE_OPTION_ARG[`${ns}.${method}`];
  if (at === undefined) return false;
  const opts = args[at];
  return typeof opts === "object" && opts !== null && (opts as { wake?: unknown }).wake === false;
}

/**
 * Every string in `value`, however deep: the pane ids a layout command names
 * among them, which is how a command queued for a pane no layout holds yet
 * finds the layout command that adds it (`layout.setPendingCommand`). Main's
 * `HostRouting` and the renderer's router both look.
 */
export function stringsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) stringsIn(item, out);
  }
  return out;
}
