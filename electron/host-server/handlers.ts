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
 * declare only the slice of deps they read (`PtyViewerDeps`, `ChatDeps`,
 * `AgentReadDeps`) —
 * or is a host-server read over `HostServerDeps`, which carries no window,
 * menu or Electron object of any kind.
 */

import { assertPositiveInt, assertString } from "../ipc-validate";
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
  toHandlerTable,
  type HandlerCtx,
} from "../bridge/method";
import type { BridgeServerDeps } from "../bridge/server";
import { UNAVAILABLE_HOST_CODE } from "../bridge/types";
import type { AppPreferences } from "../preferences";
import type { ProjectInfo } from "../projects/types";
import { resolveSpawnCwd } from "../paths";
import type { Theme, ThemeColors } from "../theme";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import type { PtyCreateOptions, PtyCreateResult } from "../../src/electron.d";
import { errorMessage } from "../lib/errors";
import {
  agentsGet,
  agentsGetActive,
  agentsGetAll,
  agentsGetPaneStatuses,
  agentsGetRecent,
  agentsGetUnseen,
  type AgentReadDeps,
} from "../bridge/handlers/agents-read";
import {
  remoteControlPair,
  remoteControlSubscribePush,
  remoteControlVapidPublicKey,
} from "../bridge/handlers/remote-control";
import type { RemoteDeviceInfo } from "../remote-control/devices";
import type { VapidKeys } from "../remote-control/push";
import type { HostLayoutSnapshot } from "./layout";
import type { HostManifest } from "./manifest";
import {
  assertHostLayoutSnapshot,
  assertHostManifest,
  assertVapidKeys,
  type OwnerSync,
} from "./owner";
import type { HostRelay, HostRemoteControl, HostServerStatus } from "./relay";
import {
  missingSessions,
  withStartedWhileAway,
} from "./started-while-away";
import type { HostWinsize } from "./winsize";

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
  extends BridgeServerDeps, PtyViewerDeps, ChatDeps, AgentReadDeps {
  backend: { pty: HostPty };
  /** Whether the daemon is reachable right now. */
  daemonStatus(): HostStatusInfo;
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
  /** The same room's owner-only side: reset, the desktop's VAPID pair. */
  relay: Pick<HostRelay, "resetIdentity" | "setVapidKeys">;
  /** Persists and announces what the owner synced (`./owner.ts`). */
  ownerSync: OwnerSync;
  /** What `hostServer.status` answers the owner (ADR-218 D4). */
  serverStatus(): HostServerStatus;
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
 * the daemon does not say — and the owner otherwise. The count goes into the
 * registry's foreign hold, and `createShaped` reads it from there.
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
  // Into the registry before the call, so `createShaped` reads the hold.
  ctx.deps.winsize.watch(paneId, session.attachedClients);
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
  });
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

function remoteControlRevoke(
  ctx: Ctx,
  id: string,
): Promise<RemoteDeviceInfo[]> {
  assertString(id, "remoteControl.revoke.id");
  return ctx.deps.remoteControl.revoke(id);
}

// ── the owner's view of this server (ADR-218 D4) ──

function hostServerStatus(ctx: Ctx): HostServerStatus {
  return ctx.deps.serverStatus();
}

/**
 * New relay identity; every phone and push subscription revoked.
 *
 * Owner-only, like pairing. When delegated integration tokens arrive (ADR-218
 * D8, slice 2) this must delete those too: "Reset pairing keys" is the
 * recovery step for a box that may be compromised.
 */
async function hostServerResetIdentity(ctx: Ctx): Promise<HostServerStatus> {
  await ctx.deps.relay.resetIdentity();
  return ctx.deps.serverStatus();
}

/**
 * The desktop's projects on this host (ADR-218 D4, D8): persisted to
 * `manifest.json` and served by `projects.getAll`; every phone hears
 * `projects.changed`. The payload is checked whole before anything is
 * written (`./owner.ts`).
 */
function hostServerSyncManifest(ctx: Ctx, manifest: HostManifest): true {
  assertHostManifest(manifest);
  return ctx.deps.ownerSync.syncManifest(manifest);
}

/**
 * The desktop's VAPID key pair (ADR-218 D3): this server signs pushes with
 * it, so a phone's one browser subscription is valid in every room. A key
 * that differs from the current one clears the subscriptions made against it.
 */
function hostServerSetVapidKeys(ctx: Ctx, keys: VapidKeys): Promise<boolean> {
  assertVapidKeys(keys);
  return ctx.deps.relay.setVapidKeys(keys);
}

/**
 * The desktop's layout for this host's workspaces, keys already bare paths
 * (ADR-218 D5): persisted to `layout.json` and served by `layout.getAll`;
 * every phone hears `layout.changed` for the workspaces that changed.
 */
function hostServerSyncLayout(ctx: Ctx, snapshot: HostLayoutSnapshot): true {
  assertHostLayoutSnapshot(snapshot);
  return ctx.deps.ownerSync.syncLayout(snapshot);
}

const METHODS = flatten({
  pty: {
    // Attaching is audited like the desktop's create; typing is not.
    create: method(hostPtyCreate, { mutating: true }),
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
  },
  projects: {
    getAll: method(projectsGetAll),
    getSelectedIndex: method(projectsGetSelectedIndex),
  },
  // Reads only. Every layout write (`apply`, `setPaneTitle`,
  // `setPendingCommand`) and the viewport report are absent, so a device is
  // answered `unavailable:host` — the renderer's once-per-session "read and
  // type" toast (`handleBridgeUnavailable`), not an error (ADR-218 D5).
  layout: {
    getAll: method(layoutGetAll),
    getLastActive: method(layoutGetLastActive),
  },
  chat: {
    getHistory: method(chatGetHistory),
    getCommands: method(chatGetCommands),
    send: method(chatSend),
    interrupt: method(chatInterrupt),
    answer: method(chatAnswer),
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
  // The owner's alone (ADR-218 D4): `localOnly` admits the `owner` caller
  // this server's socket authenticates (`./socket.ts`), and refuses every
  // device. A phone may read what the owner synced, never write it.
  hostServer: {
    status: method(hostServerStatus, { localOnly: true }),
    resetIdentity: method(hostServerResetIdentity, { localOnly: true }),
    syncManifest: method(hostServerSyncManifest, { localOnly: true }),
    syncLayout: method(hostServerSyncLayout, { localOnly: true }),
    setVapidKeys: method(hostServerSetVapidKeys, { localOnly: true, secretFirstArg: true }),
  },
});

/**
 * The table a host server's `BridgeServer` dispatches on. Every entry is
 * checked against `HostServerDeps` here, so a desktop handler that reads more
 * than this server has fails to compile rather than at a phone's first call.
 * Refusals read `unavailable:host`; only the owner may call a `localOnly`
 * method (the desktop on the owner socket pairs, revokes and syncs, D4).
 */
export const HOST_TABLE = toHandlerTable<HostServerDeps>(METHODS, {
  unavailable: { code: UNAVAILABLE_HOST_CODE, where: "on this host" },
  localOnlyCallers: new Set(["owner"]),
});
