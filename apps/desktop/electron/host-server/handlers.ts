/**
 * The host server's handler table: an explicit
 * allowlist, in the style of `remote-control/allowlist.ts`.
 *
 * The desktop's table (`bridge/handlers.ts`) is everything Manor can do. A
 * host server owns its host's projects, workspaces and layout,
 * so a phone with the lid closed may create and remove a workspace, launch an
 * agent and rearrange a layout there, as well as watch and steer what is
 * running — terminals, agents, the chat view. Adding a project to the box,
 * or changing one, stays the owner's: the desktop does it over the owner
 * channel. Every `ns.method` not listed here is answered `unavailable:host`,
 * which the renderer shows as a stated empty state (`src/bridge/client.ts`).
 *
 * Adding a method here is a deliberate decision: a feature that should work
 * with the lid closed has to be added on purpose. Each entry either reuses the
 * desktop's handler as it is — those declare only the slice of deps they
 * read (`SharedDeps`, `PtyViewerDeps`, `ChatDeps`, `AgentReadDeps`) — or is
 * a host-server one over `HostServerDeps`, which carries no window, menu or
 * Electron object of any kind.
 *
 * **Until the host is adopted** (`ownership: "pending"`) its
 * project and layout writes answer `unavailable:host` with "This host is
 * being set up", and `projects.getAll` is empty (`./ownership.ts`).
 */

import { assertString } from "../ipc-validate";
import type { HostStatusInfo } from "../backend/host-connection";
import { LOCAL_HOST_ID } from "../backend/types";
import type { RoutedBackend } from "../backend/routed-backend";
import type { AgentManager } from "../agent-persistence";
import type { UnseenAgents } from "../agent-status/unseen-agents";
import type { ChatMirror } from "../chat-mirror/mirror";
import type { SharedDeps } from "../ipc/types";
import {
  chatAnswer,
  chatGetCommands,
  chatGetHistory,
  chatGetTaskHistory,
  chatInterrupt,
  chatKey,
  chatSend,
  type ChatDeps,
} from "../bridge/handlers/chat";
import {
  pasteImageAbort,
  pasteImageBegin,
  pasteImageChunk,
  pasteImageCommit,
} from "../bridge/handlers/paste-image";
import {
  attachReturning,
  ptyClaimWinsize,
  ptyClose,
  ptyCreate,
  ptyDetach,
  ptyReset,
  ptyResize,
  ptyWrite,
  type PtyResetResult,
  type PtyViewerDeps,
} from "../bridge/handlers/pty";
import {
  projectsAdd,
  projectsCanQuickMerge,
  projectsClone,
  projectsConvertMainToWorktree,
  projectsCreateWorkspaceFolder,
  projectsCreateWorktree,
  projectsRunStartScript,
  projectsDeleteWorkspaceFolder,
  projectsGetAll,
  projectsGetSelectedIndex,
  projectsListLocalBranches,
  projectsListRemoteBranches,
  projectsQuickMergeWorktree,
  projectsRemove,
  projectsRemoveWorktree,
  projectsRenameWorkspace,
  projectsRenameWorkspaceFolder,
  projectsReorderWorkspaces,
  projectsSelectWorkspace,
  projectsSetFolderParent,
  projectsSetWorkspaceFolder,
  projectsSetWorkspaceHidden,
  projectsUpdate,
} from "../bridge/handlers/projects";
import {
  layoutApply,
  layoutMoveToWorkspace,
  layoutGetAll,
  layoutGetLastActive,
  layoutReportViewport,
  layoutSetPaneTitle,
  layoutSetPendingCommand,
} from "../bridge/handlers/layout";
import {
  agentsDelete,
  agentsMarkResumed,
  agentsMarkSeen,
  agentsSetPaneContext,
  agentsUpdate,
} from "../bridge/handlers/agents";
import {
  githubAssignIssue,
  githubCheckStatus,
  githubCloseIssue,
  githubCreateIssue,
  githubGetAllIssues,
  githubGetIssueDetail,
  githubGetMyIssues,
  githubGetPrsForBranches,
  githubGetViewerName,
  githubListRepos,
  githubProxyImage,
  linearAssociateProject,
  linearAutoMatch,
  linearCloseIssue,
  linearGetAllIssues,
  linearGetIssueDetail,
  linearGetMyIssues,
  linearGetTeams,
  linearGetViewer,
  linearIsConnected,
  linearLinkIssueToWorkspace,
  linearProxyImage,
  linearStartIssue,
  linearUnlinkIssueFromWorkspace,
} from "../bridge/handlers/integrations";
import {
  flatten,
  method,
  toHandlerTable,
  type HandlerCtx,
} from "../bridge/method";
import type { BridgeServerDeps } from "../bridge/server";
import {
  branchesStart,
  branchesStop,
  diffsStart,
  diffsStop,
} from "../bridge/handlers/branches-diffs";
import {
  filesCreate,
  filesDelete,
  filesRename,
  filesList,
  filesRead,
  filesUnwatch,
  filesWatch,
  filesWrite,
} from "../bridge/handlers/files";
import { BridgeUnavailableRefusal, UNAVAILABLE_HOST_CODE } from "../bridge/types";
import type { AppPreferences } from "../preferences";
import type { ProjectInfo } from "../projects/types";
import type { Theme, ThemeColors } from "../theme";
import type {
  PtyAttachResult,
  PtyCreateOptions,
  PtyCreateResult,
  PtyResetOptions,
} from "../../src/electron.d";
import { errorMessage } from "../lib/errors";
import {
  agentsGet,
  agentsGetActive,
  agentsGetAll,
  agentsGetFileAuthors,
  agentsGetPaneStatuses,
  agentsGetRecent,
  agentsGetUnseen,
  type AgentReadDeps,
} from "../bridge/handlers/agents-read";
import { sessionsList, sessionsTranscript } from "../bridge/handlers/sessions";
import {
  notificationsClear,
  notificationsGetAll,
  notificationsMarkAllRead,
  notificationsMarkRead,
} from "../bridge/handlers/notifications";
import {
  automationsCreate,
  automationsGet,
  automationsList,
  automationsRemove,
  automationsRunNow,
  automationsSetEnabled,
  automationsUpdate,
} from "../bridge/handlers/automations";
import {
  remoteControlPair,
  remoteControlSubscribePush,
  remoteControlVapidPublicKey,
} from "../bridge/handlers/remote-control";
import type { RemoteDeviceInfo } from "../remote-control/devices";
import type { VapidKeys } from "../remote-control/push";
import type { Adopt, AdoptionBundle } from "./adopt";
import { answerOwnerRequest } from "./cli-relay";
import type { ControlRelayResult } from "../terminal-host/control-relay-listener";
import { assertAdoptionBundle, assertVapidKeys } from "./owner";
import { assertOwned, type OwnershipState } from "./ownership";
import type { HostRelay, HostRemoteControl, HostServerStatus } from "./relay";
import type { HostWinsize } from "./winsize";

/**
 * Everything the host table reads: what every server composes
 * (`SharedDeps`, built by `createManorServer`) plus this server's own parts.
 * Not `HostDeps`: no `BrowserWindow`, no app menu, no registry of other
 * hosts — this server is one host, local to itself.
 */
export interface HostServerDeps
  extends SharedDeps, BridgeServerDeps, PtyViewerDeps, ChatDeps, AgentReadDeps {
  // The shared parts, which satisfy each handler's narrower slice.
  backend: RoutedBackend;
  agentManager: AgentManager;
  agentStatus: SharedDeps["agentStatus"];
  unseen: UnseenAgents;
  chatMirror: ChatMirror;
  getPaneHostId: SharedDeps["getPaneHostId"];
  hostStatus: SharedDeps["hostStatus"];
  /** Whether the daemon is reachable right now. */
  daemonStatus(): HostStatusInfo;
  /** The daemon's attach count decides who owns a pane's winsize. */
  winsize: HostWinsize;
  /** This server's preferences: the defaults until the desktop syncs any. */
  preferences(): AppPreferences;
  /** The theme a phone draws terminals in: Manor's default. */
  theme(): Theme;
  /** This server's own relay room: pairing, devices, push. */
  remoteControl: HostRemoteControl;
  /** The same room's owner-only side: reset, the desktop's VAPID pair. */
  relay: Pick<HostRelay, "resetIdentity" | "setVapidKeys">;
  /** Whether this host has been adopted yet (`./ownership.ts`). */
  ownership: OwnershipState;
  /** Merge the desktop's records for this host into its stores (`./adopt.ts`). */
  adopt: Adopt;
  /** What `hostServer.status` answers the owner. */
  serverStatus(): HostServerStatus;
  /** The owner has read `identityReset`; stop reporting it. */
  acknowledgeIdentityReset(): void;
  /** This box's name, for the messages that say which host refused. */
  hostName(): string;
}

type Ctx = HandlerCtx<HostServerDeps>;

// ── ownership ──

/** What the ownership gate reads. */
interface OwnershipDeps {
  ownership: Pick<OwnershipState, "current">;
}

/**
 * `fn`, refused with "This host is being set up" until the host has been
 * adopted: a project or layout write made before adoption would be one the
 * desktop's records then have to merge with.
 */
function owned<D, A extends unknown[], R>(
  fn: (ctx: HandlerCtx<D>, ...args: A) => R,
): (ctx: HandlerCtx<D & OwnershipDeps>, ...args: A) => R {
  return (ctx, ...args) => {
    assertOwned(ctx.deps.ownership);
    return fn(ctx, ...args);
  };
}

/** No projects until the host is adopted: the desktop still has them. */
function hostProjectsGetAll(ctx: Ctx): Promise<ProjectInfo[]> {
  if (ctx.deps.ownership.current() !== "host") return Promise.resolve([]);
  return projectsGetAll(ctx);
}

// ── pty ──

/**
 * Open a pane's session — the desktop's `pty.create`, which spawns one the
 * daemon does not have — with the daemon's winsize answer set
 * first (`./winsize.ts`): a follower whenever a client other than
 * this server is attached to the session — or the daemon does not say — and
 * the owner otherwise. The count goes into the registry's foreign hold, and
 * `createShaped` reads it from there. A session not yet running has nobody
 * else on it.
 */
export async function ptyCreateWithHold(
  ctx: Ctx,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyCreateOptions | null,
): Promise<PtyCreateResult> {
  assertString(paneId, "paneId");
  let session: { alive: boolean; attachedClients?: number } | undefined;
  try {
    const sessions = await ctx.deps.backend.pty.listSessions();
    session = sessions.find((s) => s.sessionId === paneId);
  } catch (err) {
    return {
      ok: false,
      reason: "host-unavailable",
      hostId: LOCAL_HOST_ID,
      error: errorMessage(err),
    };
  }
  // Into the registry before the call, so `createShaped` reads the hold.
  ctx.deps.winsize.watch(paneId, session?.alive ? session.attachedClients : 0);
  return ptyCreate(ctx, paneId, cwd, cols, rows, opts);
}

/**
 * A device back from a dropped connection re-attaching to a session it had
 * (`pty.attach`): never spawns, makes no bid for the winsize. The
 * daemon's attach count goes into the registry first, as for `create`.
 */
export async function hostPtyAttach(ctx: Ctx, paneId: string): Promise<PtyAttachResult> {
  assertString(paneId, "paneId");
  const { pty } = ctx.deps.backend;
  let session: { alive: boolean; attachedClients?: number } | undefined;
  try {
    const sessions = await pty.listSessions();
    session = sessions.find((s) => s.sessionId === paneId);
  } catch (err) {
    return {
      ok: false,
      reason: "host-unavailable",
      hostId: LOCAL_HOST_ID,
      error: errorMessage(err),
    };
  }
  if (!session?.alive) return { ok: false, reason: "exited" };
  ctx.deps.winsize.watch(paneId, session.attachedClients);
  try {
    const snapshot = await pty.attachExisting(paneId);
    if (!snapshot) return { ok: false, reason: "exited" };
    return attachReturning(ctx.caller, paneId, snapshot, LOCAL_HOST_ID);
  } catch (err) {
    return { ok: false, reason: "error", error: errorMessage(err) };
  }
}

/**
 * A pane's session killed and started afresh in place (`pty.reset`), for a
 * desktop window that holds this server's bridge itself. The
 * fresh session has nobody else on it, so the hold says so before the
 * create-shaped answer reads it.
 */
function hostPtyReset(
  ctx: Ctx,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  opts?: PtyResetOptions | null,
): Promise<PtyResetResult> {
  assertString(paneId, "paneId");
  ctx.deps.winsize.watch(paneId, 0);
  return ptyReset(ctx, paneId, cwd, cols, rows, opts);
}

// ── preferences, theme ──

function preferencesGetAll(ctx: Ctx): AppPreferences {
  return ctx.deps.preferences();
}

function themeGet(ctx: Ctx): Theme {
  return ctx.deps.theme();
}

function themeGetSelectedName(): string {
  return "__default__";
}

function themeHasGhosttyConfig(): boolean {
  return false;
}

/** There is one theme here; previewing any name shows it. */
function themePreview(ctx: Ctx, name: string): Theme {
  assertString(name, "name");
  return ctx.deps.theme();
}

async function themeAllColors(): Promise<Record<string, ThemeColors>> {
  return {};
}

// ── the daemon ──

/** The one host this server is, and whether its daemon is reachable. */
function hostsList(ctx: Ctx): HostStatusInfo[] {
  return [ctx.deps.daemonStatus()];
}

// ── remote control, this server's own room ──

function remoteControlListDevices(ctx: Ctx): RemoteDeviceInfo[] {
  return ctx.deps.remoteControl.listDevices();
}

function remoteControlRevoke(
  ctx: Ctx,
  id: string,
): Promise<RemoteDeviceInfo[]> {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

// ── the owner's view of this server ──

function hostServerStatus(ctx: Ctx): HostServerStatus {
  const status = ctx.deps.serverStatus();
  // `identityReset` is for the owner's next read only.
  ctx.deps.acknowledgeIdentityReset();
  return status;
}

/**
 * New relay identity; every phone and push subscription revoked.
 *
 * Owner-only, like pairing. It deletes the delegated Linear token too:
 * "Reset pairing keys" is the recovery step for a box that may be
 * compromised.
 */
async function hostServerResetIdentity(ctx: Ctx): Promise<HostServerStatus> {
  await ctx.deps.relay.resetIdentity();
  ctx.deps.linearManager.clearToken();
  return ctx.deps.serverStatus();
}

/**
 * The desktop's VAPID key pair: this server signs pushes with
 * it, so a phone's one browser subscription is valid in every room. A key
 * that differs from the current one clears the subscriptions made against it.
 */
function hostServerSetVapidKeys(ctx: Ctx, keys: VapidKeys): Promise<boolean> {
  assertVapidKeys(keys);
  return ctx.deps.relay.setVapidKeys(keys);
}

/**
 * The desktop's Linear key for this host, sealed in this host's
 * `SecretBox`; null deletes it. Answers whether Linear is on. `secretFirstArg`
 * keeps the key out of the audit line.
 */
async function hostServerSetLinearToken(ctx: Ctx, token: string | null): Promise<boolean> {
  if (token === null) {
    ctx.deps.linearManager.clearToken();
  } else {
    assertString(token, "hostServer.setLinearToken.token");
    if (token.trim() === "") throw new Error("hostServer.setLinearToken.token is empty");
    await ctx.deps.linearManager.saveToken(token);
  }
  return ctx.deps.linearManager.isConnected();
}

/**
 * `fn`, refused `unavailable:host` until the user has turned Linear on for
 * this host: no token is here, so there is nothing to call Linear with.
 */
function withLinear<A extends unknown[], R>(
  fn: (ctx: HandlerCtx<Pick<SharedDeps, "linearManager" | "projectManager">>, ...args: A) => R,
): (ctx: Ctx, ...args: A) => R {
  return (ctx, ...args) => {
    if (!ctx.deps.linearManager.isConnected()) {
      throw new BridgeUnavailableRefusal(
        `Linear isn't turned on for ${ctx.deps.hostName()}`,
        UNAVAILABLE_HOST_CODE,
      );
    }
    return fn(ctx, ...args);
  };
}

/**
 * Adoption: the desktop's projects, agents and layout for this
 * host, merged into this server's stores with the host winning every
 * conflict, then `ownership: "host"`. Checked whole first: a bad bundle
 * writes nothing. Sending it again is harmless. Answers the new status.
 */
async function hostServerAdopt(ctx: Ctx, bundle: AdoptionBundle): Promise<HostServerStatus> {
  assertAdoptionBundle(bundle);
  await ctx.deps.adopt(bundle);
  return ctx.deps.serverStatus();
}

/**
 * A control request (`electron/routes/`) about one of this host's projects
 * or agents, from the desktop's MCP or CLI: run through the
 * same server routes the box's own CLI reaches (`./cli-relay.ts`). Answers
 * the HTTP status and body; never rejects.
 */
function hostServerControl(
  ctx: Ctx,
  method: string,
  path: string,
  body: unknown,
): Promise<ControlRelayResult> {
  assertString(method, "hostServer.control.method");
  assertString(path, "hostServer.control.path");
  return answerOwnerRequest({ routes: ctx.deps, ownership: ctx.deps.ownership }, { method, path, body });
}

const METHODS = flatten({
  pty: {
    // Spawns, or attaches; audited like the desktop's create. Typing is not.
    create: method(ptyCreateWithHold, { mutating: true }),
    attach: method(hostPtyAttach),
    // A desktop window's own bridge resets and ends its panes
    // here, as it does on its own server.
    reset: method(hostPtyReset, { mutating: true }),
    close: method(ptyClose, { mutating: true }),
    write: method(ptyWrite),
    // The registry's foreign hold drops a device's resize and claim while
    // another client of the daemon has the session (`./winsize.ts`).
    resize: method(ptyResize),
    claimWinsize: method(ptyClaimWinsize),
    detach: method(ptyDetach),
  },
  agents: {
    getAll: method(agentsGetAll),
    get: method(agentsGet),
    getActive: method(agentsGetActive),
    getRecent: method(agentsGetRecent),
    getUnseen: method(agentsGetUnseen),
    getPaneStatuses: method(agentsGetPaneStatuses),
    // Which of this host's agents wrote each file of a workspace.
    getFileAuthors: method(agentsGetFileAuthors),
    // A renderer's word on a pane's project overrides the server's own.
    setPaneContext: method(agentsSetPaneContext, { mutating: true }),
    // The desktop forwards its writes by agent id for the host's agents here.
    update: method(agentsUpdate, { mutating: true }),
    delete: method(agentsDelete, { mutating: true }),
    markSeen: method(agentsMarkSeen, { mutating: true }),
    markResumed: method(agentsMarkResumed, { mutating: true }),
  },
  // This host's agent stores, read-only.
  sessions: {
    list: method(sessionsList),
    transcript: method(sessionsTranscript),
  },
  // A device works inside the projects on this host: makes and
  // removes workspaces and arranges them. Adding a project to the box, or
  // changing or removing one — group settings arrive as project updates
  // — is the owner's (`localOnly`).
  projects: {
    getAll: method(hostProjectsGetAll),
    getSelectedIndex: method(projectsGetSelectedIndex),
    listLocalBranches: method(projectsListLocalBranches),
    listRemoteBranches: method(projectsListRemoteBranches),
    canQuickMerge: method(projectsCanQuickMerge),
    createWorktree: method(owned(projectsCreateWorktree), { mutating: true }),
    runStartScript: method(owned(projectsRunStartScript), { mutating: true }),
    // The desktop forwards these for its projects here.
    quickMergeWorktree: method(owned(projectsQuickMergeWorktree), { mutating: true }),
    convertMainToWorktree: method(owned(projectsConvertMainToWorktree), { mutating: true }),
    selectWorkspace: method(owned(projectsSelectWorkspace), { mutating: true }),
    removeWorktree: method(owned(projectsRemoveWorktree), { mutating: true }),
    renameWorkspace: method(owned(projectsRenameWorkspace), { mutating: true }),
    reorderWorkspaces: method(owned(projectsReorderWorkspaces), { mutating: true }),
    setWorkspaceHidden: method(owned(projectsSetWorkspaceHidden), { mutating: true }),
    createWorkspaceFolder: method(owned(projectsCreateWorkspaceFolder), { mutating: true }),
    renameWorkspaceFolder: method(owned(projectsRenameWorkspaceFolder), { mutating: true }),
    setFolderParent: method(owned(projectsSetFolderParent), { mutating: true }),
    deleteWorkspaceFolder: method(owned(projectsDeleteWorkspaceFolder), { mutating: true }),
    setWorkspaceFolder: method(owned(projectsSetWorkspaceFolder), { mutating: true }),
    add: method(owned(projectsAdd), { mutating: true, localOnly: true }),
    clone: method(owned(projectsClone), { mutating: true, localOnly: true }),
    update: method(owned(projectsUpdate), { mutating: true, localOnly: true }),
    remove: method(owned(projectsRemove), { mutating: true, localOnly: true }),
  },
  // This host's notification log: its automations' runs, kept while no
  // desktop is open, which the desktop's bell and a phone's merge in.
  // Reading and marking it read is anyone's.
  notifications: {
    getAll: method(notificationsGetAll),
    markRead: method(notificationsMarkRead, { mutating: true }),
    markAllRead: method(notificationsMarkAllRead, { mutating: true }),
    clear: method(notificationsClear, { mutating: true }),
  },
  // This host's automations, which this server fires with the lid closed.
  // A device may read them, run one now and pause or resume one; making,
  // changing and deleting one is the owner's, as a project's settings are
  // (`localOnly`). Until adoption every write is refused.
  automations: {
    list: method(automationsList),
    get: method(automationsGet),
    runNow: method(owned(automationsRunNow), { mutating: true }),
    setEnabled: method(owned(automationsSetEnabled), { mutating: true }),
    create: method(owned(automationsCreate), { mutating: true, localOnly: true }),
    update: method(owned(automationsUpdate), { mutating: true, localOnly: true }),
    remove: method(owned(automationsRemove), { mutating: true, localOnly: true }),
  },
  // The layout is this server's: an agent tab applied here
  // spawns on the server, whoever is looking.
  layout: {
    getAll: method(layoutGetAll),
    getLastActive: method(layoutGetLastActive),
    apply: method(owned(layoutApply), { mutating: true }),
    moveToWorkspace: method(owned(layoutMoveToWorkspace), { mutating: true }),
    setPaneTitle: method(owned(layoutSetPaneTitle), { mutating: true }),
    setPendingCommand: method(owned(layoutSetPendingCommand), { mutating: true }),
    reportViewport: method(owned(layoutReportViewport)),
  },
  // `gh` runs here, in the checkout, with the box's own sign-in.
  // The feedback upload is the desktop's flow and stays off the table.
  github: {
    getPrsForBranches: method(githubGetPrsForBranches),
    listRepos: method(githubListRepos),
    getViewerName: method(githubGetViewerName),
    checkStatus: method(githubCheckStatus),
    getMyIssues: method(githubGetMyIssues),
    getAllIssues: method(githubGetAllIssues),
    getIssueDetail: method(githubGetIssueDetail),
    proxyImage: method(githubProxyImage),
    assignIssue: method(githubAssignIssue, { mutating: true }),
    closeIssue: method(githubCloseIssue, { mutating: true }),
    createIssue: method(githubCreateIssue, { mutating: true }),
  },
  // A workspace's linked issues are project records; the rest of Linear is
  // not on this host yet.
  //
  // The rest of `linear.*` runs here with the token the user delegated;
  // `connect` and `disconnect` stay the desktop's.
  linear: {
    isConnected: method(linearIsConnected),
    getViewer: method(withLinear(linearGetViewer)),
    getTeams: method(withLinear(linearGetTeams)),
    getMyIssues: method(withLinear(linearGetMyIssues)),
    getIssueDetail: method(withLinear(linearGetIssueDetail)),
    getAllIssues: method(withLinear(linearGetAllIssues)),
    proxyImage: method(withLinear(linearProxyImage)),
    autoMatch: method(withLinear(linearAutoMatch)),
    startIssue: method(withLinear(linearStartIssue), { mutating: true }),
    closeIssue: method(withLinear(linearCloseIssue), { mutating: true }),
    linkIssueToWorkspace: method(owned(linearLinkIssueToWorkspace), { mutating: true }),
    unlinkIssueFromWorkspace: method(owned(linearUnlinkIssueFromWorkspace), {
      mutating: true,
    }),
    associateProject: method(owned(linearAssociateProject), { mutating: true }),
  },
  // This box's own workspaces' branches and diffs, watched here for each
  // connection that asks: a phone, or a desktop window's own
  // bridge. A viewer's own view, so none of it is audited.
  branches: {
    start: method(branchesStart),
    stop: method(branchesStop),
  },
  diffs: {
    start: method(diffsStart),
    stop: method(diffsStop),
  },
  // This box's workspaces' files, for a file pane: a phone reading
  // one with the lid closed, or a desktop window's own bridge. Saving,
  // creating, renaming and deleting change what this host's agents work on,
  // so they are audited.
  files: {
    list: method(filesList),
    read: method(filesRead),
    write: method(filesWrite, { mutating: true }),
    create: method(filesCreate, { mutating: true }),
    rename: method(filesRename, { mutating: true }),
    delete: method(filesDelete, { mutating: true }),
    watch: method(filesWatch),
    unwatch: method(filesUnwatch),
  },
  chat: {
    getHistory: method(chatGetHistory),
    getTaskHistory: method(chatGetTaskHistory),
    getCommands: method(chatGetCommands),
    send: method(chatSend),
    interrupt: method(chatInterrupt),
    key: method(chatKey),
    answer: method(chatAnswer),
  },
  // A device pastes an image into this host's panes, and the
  // file lands on this box. Only the write is audited, as on the desktop.
  pasteImage: {
    begin: method(pasteImageBegin),
    chunk: method(pasteImageChunk),
    commit: method(pasteImageCommit, { mutating: true }),
    abort: method(pasteImageAbort),
  },
  preferences: {
    getAll: method(preferencesGetAll),
  },
  theme: {
    get: method(themeGet),
    getSelectedName: method(themeGetSelectedName),
    hasGhosttyConfig: method(themeHasGhosttyConfig),
    preview: method(themePreview),
    allColors: method(themeAllColors),
  },
  hosts: {
    list: method(hostsList),
  },
  // A token that can pair more devices survives its own revocation: what
  // changes who can reach this room is the owner's alone (`localOnly`, so a
  // device is answered `unavailable:host`). The push pair is for devices.
  remoteControl: {
    pair: method(remoteControlPair, { localOnly: true }),
    listDevices: method(remoteControlListDevices, { localOnly: true }),
    revoke: method(remoteControlRevoke, { localOnly: true }),
    vapidPublicKey: method(remoteControlVapidPublicKey),
    subscribePush: method(remoteControlSubscribePush),
  },
  // The owner's alone: `localOnly` admits the `owner` caller
  // this server's socket authenticates (`./socket.ts`), and refuses every
  // device.
  hostServer: {
    status: method(hostServerStatus, { localOnly: true }),
    resetIdentity: method(hostServerResetIdentity, { localOnly: true }),
    setVapidKeys: method(hostServerSetVapidKeys, { localOnly: true, secretFirstArg: true }),
    setLinearToken: method(hostServerSetLinearToken, { localOnly: true, secretFirstArg: true }),
    adopt: method(hostServerAdopt, { localOnly: true }),
    control: method(hostServerControl, { localOnly: true, mutating: true }),
  },
});

/**
 * `ns.method` → handler, as the host table declares each: what the desktop's
 * owner-channel client is typed from (`backend/host-server-client.ts`).
 */
export type HostHandlers = {
  [K in keyof typeof METHODS]: (typeof METHODS)[K]["fn"];
};

/**
 * The table a host server's `BridgeServer` dispatches on. Every entry is
 * checked against `HostServerDeps` here, so a desktop handler that reads more
 * than this server has fails to compile rather than at a phone's first call.
 * Refusals read `unavailable:host`; only the owner may call a `localOnly`
 * method (the desktop on the owner socket pairs, revokes and sets up
 * projects).
 */
export const HOST_TABLE = toHandlerTable<HostServerDeps>(METHODS, {
  unavailable: { code: UNAVAILABLE_HOST_CODE, where: "on this host" },
  localOnlyCallers: new Set(["owner"]),
});
