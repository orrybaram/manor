/**
 * The host server's handler table (ADR-218 D5, D6): an explicit allowlist,
 * in the style of `remote-control/allowlist.ts`.
 *
 * The desktop's table (`bridge/handlers.ts`) is everything Manor can do. A
 * host server in slice 1 can do much less, on purpose: the desktop owns
 * projects and layout, so a phone with the lid closed may watch and steer
 * what is already running — terminals, agents, the chat view — and may not
 * create a workspace, launch an agent or rearrange a layout. Every
 * `ns.method` not listed here is answered `unavailable:host`, which the
 * renderer shows as a stated empty state (`src/bridge/client.ts`).
 *
 * Adding a method here is the decision ADR-218's "Harder" section warns
 * about: a feature that should work with the lid closed has to be added on
 * purpose. Each entry either reuses the desktop's handler as it is — those
 * declare only the slice of deps they read (`PtyViewerDeps`, `ChatDeps`) —
 * or is a host-server read over `HostServerDeps`, which carries no window,
 * menu or Electron object of any kind.
 */

import { assertPositiveInt, assertString } from "../ipc-validate";
import type { AgentInfo } from "../agent-persistence";
import type { AgentStatusDriver } from "../agent-status/driver";
import type { PaneStatusUpdate } from "../agent-status/effects";
import type { HostStatusInfo } from "../backend/host-connection";
import { LOCAL_HOST_ID, type PtyBackend } from "../backend/types";
import {
  chatAnswer,
  chatGetCommands,
  chatGetHistory,
  chatInterrupt,
  chatSend,
  type ChatDeps,
} from "../bridge/handlers/chat";
import {
  createShaped,
  ptyClaimWinsize,
  ptyDetach,
  ptyResize,
  ptyWrite,
  type PtyViewerDeps,
} from "../bridge/handlers/pty";
import {
  flatten,
  method,
  ruleSet,
  type BridgeHandler,
  type HandlerCtx,
  type Method,
  type MethodRules,
} from "../bridge/method";
import type { HandlerTable } from "../bridge/server-core";
import type { BridgeServerDeps } from "../ipc/types";
import type { AppPreferences } from "../preferences";
import type { ProjectInfo } from "../projects/types";
import { resolveSpawnCwd } from "../paths";
import type { Theme, ThemeColors } from "../theme";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import type { PtyCreateOptions, PtyCreateResult } from "../../src/electron.d";
import { errorMessage } from "../lib/errors";
import type { AgentQuery } from "../bridge/handlers/agents";
import {
  remoteControlPair,
  remoteControlSubscribePush,
  remoteControlVapidPublicKey,
} from "../bridge/handlers/remote-control";
import type { RemoteDeviceInfo } from "../remote-control/devices";
import type { HostRemoteControl, HostServerStatus } from "./relay";
import {
  missingSessions,
  withStartedWhileAway,
} from "./started-while-away";
import {
  hasOtherClients,
  ownSocketsFor,
  type HostWinsize,
} from "./winsize";

/** The daemon calls the host server's handlers make. */
export type HostPty = Pick<
  PtyBackend,
  | "write"
  | "resize"
  | "detach"
  | "getSnapshot"
  | "createOrAttach"
  | "listSessions"
>;

/**
 * Everything the host table reads (ADR-218 D6). Not `HostDeps`: no
 * `BrowserWindow`, no app menu, no registry of other hosts — this server is
 * one host, local to itself.
 */
export interface HostServerDeps
  extends BridgeServerDeps, PtyViewerDeps, ChatDeps {
  backend: { pty: HostPty };
  /** Whether the daemon is reachable right now. */
  daemonStatus(): HostStatusInfo;
  agentManager: {
    getAllAgents(opts?: AgentQuery): AgentInfo[];
    getAgentById(id: string): AgentInfo | null;
    getActiveAgents(): AgentInfo[];
  };
  agentStatus: Pick<AgentStatusDriver, "getAllPaneStatuses">;
  unseenRespondedAgents: ReadonlySet<string>;
  unseenInputAgents: ReadonlySet<string>;
  /** The manifest's projects over git's worktrees on this box. */
  projects(): Promise<ProjectInfo[]>;
  /** The desktop's last layout snapshot for this host. */
  layout(): {
    workspaces: Record<string, LayoutEntry>;
    lastActiveWorkspacePath: string | null;
  };
  /** The daemon's attach count decides who owns a pane's winsize (D5). */
  winsize: HostWinsize;
  /** This server's preferences: the defaults until the desktop syncs any. */
  preferences(): AppPreferences;
  /** The theme a phone draws terminals in: Manor's default. */
  theme(): Theme;
  /** This server's own relay room: pairing, devices, push (ADR-218 D3). */
  remoteControl: HostRemoteControl;
  /** The owner's view of this server (ADR-218 D4). */
  hostServer: {
    status(): HostServerStatus;
    resetIdentity(): Promise<HostServerStatus>;
    /** Validates, persists and announces (`./owner.ts`). */
    syncManifest(manifest: unknown): true;
    /** True when the key changed (and subscriptions were cleared). */
    setVapidKeys(keys: unknown): Promise<boolean>;
    /** Validates, persists and announces (`./owner.ts`). */
    syncLayout(snapshot: unknown): true;
  };
}

type Ctx = HandlerCtx<HostServerDeps>;

// ── pty ──

/**
 * Attach to a session the daemon already runs, as a viewer — never spawn
 * one. Starting terminals from the phone waits for slice 2, when the host
 * server owns the layout a new pane would go into (ADR-218 D5).
 *
 * The winsize answer is the daemon's (ADR-218 D5, `./winsize.ts`): a follower
 * whenever a client other than this server is attached to the session — or
 * the daemon does not say — and the owner otherwise.
 */
export async function hostPtyCreate(
  ctx: Ctx,
  paneId: string,
  cwd: string | null,
  cols: number,
  rows: number,
  _opts?: PtyCreateOptions | null,
): Promise<PtyCreateResult> {
  assertString(paneId, "paneId");
  if (cwd !== null) assertString(cwd, "cwd");
  assertPositiveInt(cols, "cols");
  assertPositiveInt(rows, "rows");
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
  if (!session?.alive) {
    return {
      ok: false,
      reason: "error",
      error:
        "This terminal isn't running on the host. Starting terminals from here comes in a later version.",
    };
  }
  const foreign = hasOtherClients(
    session.attachedClients,
    ownSocketsFor(paneId),
  );
  // Before the attach, so the ownership push it triggers already knows.
  ctx.deps.winsize.watch(paneId, foreign);
  return createShaped(ctx, paneId, cols, rows, async (c, r) => {
    try {
      const result = await pty.createOrAttach(
        paneId,
        resolveSpawnCwd(cwd),
        c,
        r,
      );
      return {
        ok: true as const,
        hostId: LOCAL_HOST_ID,
        snapshot: result.snapshot?.screenAnsi || null,
        snapshotSeq: result.snapshot?.seq,
        prewarmed: result.snapshot !== null,
      };
    } catch (err) {
      return {
        ok: false as const,
        reason: "error" as const,
        error: errorMessage(err),
      };
    }
  }, foreign);
}

/**
 * A resize from a viewer that does not own the pane is dropped, as on the
 * desktop. Here that includes every device while another client of the daemon
 * has the session: it is not this phone's grid to move.
 */
function hostPtyResize(
  ctx: Ctx,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  assertString(paneId, "paneId");
  if (ctx.deps.winsize.isForeign(paneId)) return Promise.resolve();
  return ptyResize(ctx, paneId, cols, rows);
}

/** No claim while another client of the daemon has the session. */
function hostPtyClaimWinsize(ctx: Ctx, paneId: string): boolean {
  assertString(paneId, "paneId");
  if (ctx.deps.winsize.isForeign(paneId)) return false;
  return ptyClaimWinsize(ctx, paneId);
}

// ── agents ──

function agentsGetAll(ctx: Ctx, opts?: AgentQuery): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents(opts);
}

function agentsGet(ctx: Ctx, agentId: string): AgentInfo | null {
  assertString(agentId, "agentId");
  return ctx.deps.agentManager.getAgentById(agentId);
}

function agentsGetActive(ctx: Ctx): AgentInfo[] {
  return ctx.deps.agentManager.getActiveAgents();
}

function agentsGetRecent(ctx: Ctx, opts?: { limit?: number }): AgentInfo[] {
  return ctx.deps.agentManager.getAllAgents({ limit: opts?.limit ?? 50 });
}

function agentsGetUnseen(ctx: Ctx): {
  responded: string[];
  requires_input: string[];
} {
  return {
    responded: [...ctx.deps.unseenRespondedAgents],
    requires_input: [...ctx.deps.unseenInputAgents],
  };
}

function agentsGetPaneStatuses(ctx: Ctx): PaneStatusUpdate[] {
  return ctx.deps.agentStatus.getAllPaneStatuses();
}

// ── projects, layout ──

function projectsGetAll(ctx: Ctx): Promise<ProjectInfo[]> {
  return ctx.deps.projects();
}

/** Selection is a desktop window's; a phone starts at the first project. */
function projectsGetSelectedIndex(): number {
  return 0;
}

/**
 * The desktop's snapshot, plus a "Started while away" tab for each live
 * daemon session it does not place (ADR-218 D5). Only the snapshot when the
 * daemon or git cannot be asked: a phone still gets its layout.
 */
async function layoutGetAll(ctx: Ctx): Promise<Record<string, LayoutEntry>> {
  const { workspaces } = ctx.deps.layout();
  try {
    const missing = missingSessions(
      workspaces,
      await ctx.deps.backend.pty.listSessions(),
    );
    if (missing.length === 0) return workspaces;
    // Bounded: a git that hangs must not hold up the layout the phone needs.
    const projects = await Promise.race([
      ctx.deps.projects(),
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error("projects timed out")), 3_000);
        t.unref?.();
      }),
    ]);
    const paths = projects.flatMap((p) => p.workspaces.map((w) => w.path));
    return withStartedWhileAway(workspaces, missing, paths);
  } catch {
    return workspaces;
  }
}

function layoutGetLastActive(ctx: Ctx): string | null {
  return ctx.deps.layout().lastActiveWorkspacePath;
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

// ── remote control, this server's own room (ADR-218 D3) ──

function remoteControlListDevices(ctx: Ctx): RemoteDeviceInfo[] {
  return ctx.deps.remoteControl.listDevices();
}

function remoteControlRevoke(ctx: Ctx, id: string): RemoteDeviceInfo[] {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

// ── the owner's view of this server (ADR-218 D4) ──

function hostServerStatus(ctx: Ctx): HostServerStatus {
  return ctx.deps.hostServer.status();
}

/**
 * New relay identity; every phone and push subscription revoked.
 *
 * Owner-only, like pairing. When delegated integration tokens arrive (ADR-218
 * D8, slice 2) this must delete those too: "Reset pairing keys" is the
 * recovery step for a box that may be compromised.
 */
function hostServerResetIdentity(ctx: Ctx): Promise<HostServerStatus> {
  return ctx.deps.hostServer.resetIdentity();
}

/**
 * The desktop's projects on this host (ADR-218 D4, D8): persisted to
 * `manifest.json` and served by `projects.getAll`; every phone hears
 * `projects.changed`. The payload is checked whole before anything is
 * written (`./owner.ts`).
 */
function hostServerSyncManifest(ctx: Ctx, manifest: unknown): true {
  return ctx.deps.hostServer.syncManifest(manifest);
}

/**
 * The desktop's VAPID key pair (ADR-218 D3): this server signs pushes with
 * it, so a phone's one browser subscription is valid in every room. A key
 * that differs from the current one clears the subscriptions made against it.
 */
function hostServerSetVapidKeys(ctx: Ctx, keys: unknown): Promise<boolean> {
  return ctx.deps.hostServer.setVapidKeys(keys);
}

/**
 * The desktop's layout for this host's workspaces, keys already bare paths
 * (ADR-218 D5): persisted to `layout.json` and served by `layout.getAll`;
 * every phone hears `layout.changed` for the workspaces that changed.
 */
function hostServerSyncLayout(ctx: Ctx, snapshot: unknown): true {
  return ctx.deps.hostServer.syncLayout(snapshot);
}

/**
 * A host table entry: `method`, checked against `HostServerDeps`, so a
 * desktop handler that reads more than this server has fails to compile here
 * rather than at a phone's first call.
 */
function hostMethod<
  F extends BridgeHandler<HostServerDeps>,
  const R extends MethodRules = Record<never, never>,
>(fn: F, rules?: R): Method<F, R> {
  return method(fn, rules);
}

const METHODS = flatten({
  pty: {
    // Attaching is audited like the desktop's create; typing is not.
    create: hostMethod(hostPtyCreate, { mutating: true }),
    write: hostMethod(ptyWrite),
    resize: hostMethod(hostPtyResize),
    claimWinsize: hostMethod(hostPtyClaimWinsize),
    detach: hostMethod(ptyDetach),
  },
  agents: {
    getAll: hostMethod(agentsGetAll),
    get: hostMethod(agentsGet),
    getActive: hostMethod(agentsGetActive),
    getRecent: hostMethod(agentsGetRecent),
    getUnseen: hostMethod(agentsGetUnseen),
    getPaneStatuses: hostMethod(agentsGetPaneStatuses),
  },
  projects: {
    getAll: hostMethod(projectsGetAll),
    getSelectedIndex: hostMethod(projectsGetSelectedIndex),
  },
  // Reads only. Every layout write (`apply`, `setPaneTitle`,
  // `setPendingCommand`) and the viewport report are absent, so a device is
  // answered `unavailable:host` — the renderer's once-per-session "read and
  // type" toast (`handleBridgeUnavailable`), not an error (ADR-218 D5).
  layout: {
    getAll: hostMethod(layoutGetAll),
    getLastActive: hostMethod(layoutGetLastActive),
  },
  chat: {
    getHistory: hostMethod(chatGetHistory),
    getCommands: hostMethod(chatGetCommands),
    send: hostMethod(chatSend),
    interrupt: hostMethod(chatInterrupt),
    answer: hostMethod(chatAnswer),
  },
  preferences: {
    getAll: hostMethod(preferencesGetAll),
  },
  theme: {
    get: hostMethod(themeGet),
    getSelectedName: hostMethod(themeGetSelectedName),
    hasGhosttyConfig: hostMethod(themeHasGhosttyConfig),
    preview: hostMethod(themePreview),
    allColors: hostMethod(themeAllColors),
  },
  hosts: {
    list: hostMethod(hostsList),
  },
  // A token that can pair more devices survives its own revocation: what
  // changes who can reach this room is the owner's alone (`localOnly`, so a
  // device is answered `unavailable:host`). The push pair is for devices.
  remoteControl: {
    pair: hostMethod(remoteControlPair, { localOnly: true }),
    listDevices: hostMethod(remoteControlListDevices, { localOnly: true }),
    revoke: hostMethod(remoteControlRevoke, { localOnly: true }),
    vapidPublicKey: hostMethod(remoteControlVapidPublicKey),
    subscribePush: hostMethod(remoteControlSubscribePush),
  },
  // The owner's alone (ADR-218 D4): `localOnly` admits the `owner` caller
  // this server's socket authenticates (`./socket.ts`), and refuses every
  // device. A phone may read what the owner synced, never write it.
  hostServer: {
    status: hostMethod(hostServerStatus, { localOnly: true }),
    resetIdentity: hostMethod(hostServerResetIdentity, { localOnly: true }),
    syncManifest: hostMethod(hostServerSyncManifest, { localOnly: true }),
    syncLayout: hostMethod(hostServerSyncLayout, { localOnly: true }),
    setVapidKeys: hostMethod(hostServerSetVapidKeys, { localOnly: true, secretFirstArg: true }),
  },
});

const methods = METHODS as Record<string, Method>;

/** The table `BridgeServerCore` dispatches on a host server. */
export const HOST_TABLE: HandlerTable<HostServerDeps> = {
  // Each entry was checked against `HostServerDeps` by `hostMethod`.
  handlers: Object.fromEntries(
    Object.entries(methods).map(([key, entry]) => [key, entry.fn]),
  ) as Record<string, BridgeHandler<HostServerDeps>>,
  localOnly: ruleSet(methods, "localOnly"),
  mutating: ruleSet(methods, "mutating"),
  secretFirstArg: ruleSet(methods, "secretFirstArg"),
};
