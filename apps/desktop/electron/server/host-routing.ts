/**
 * The desktop as a client of each host server.
 *
 * Once a remote host has adopted its records, its projects, layout and
 * agents are its server's. The desktop reaches them only through that
 * host's `HostProxy`, and this is where it does:
 *
 * - **Routing** (`BridgeForward`). A bridge method that names its host in
 *   an argument (`route` in its rules, `../bridge/method.ts`) and names an
 *   adopted remote host is answered by that host's server: the proxy
 *   rewrites the arguments and the answer, and a host that is away refuses
 *   with `unavailable:host-away` ("wsl-box is offline"). Nothing is queued.
 * - **Waking**. A write for a host whose box is asleep wakes
 *   it first, waits for it (bounded by `WAKE_WAIT_MS`), then goes; a read
 *   never wakes one, and answers from the cache as for any host away.
 * - **Merged reads.** The proxies' projects (for `ProjectManager`, as
 *   `RemoteProjects`), layouts, agents and pane statuses, which the shared reads add to the
 *   desktop's own — the cache's while a host is away.
 * - **What a forwarded call carries along.** A layout command takes the
 *   calling renderer's origin, so its selection hint lands back on that
 *   renderer, and the pending command of any pane it adds, which the
 *   renderer queued a moment before without knowing the pane's host. Setup
 *   and teardown progress the host sends its owner goes back to whoever
 *   asked.
 * - **A remote pane's terminal**. Its `pty.*` calls are routed
 *   by pane like any other: the host's server creates, attaches, types into
 *   and resizes it, and types its pending command into a fresh one. Its
 *   events come back through the proxy (`wirePty`) while a caller of the
 *   desktop's is subscribed to them — a phone paired only with the desktop,
 *   or a desktop window whose own stream to the host is down. The desktop
 *   never attaches it over the host's daemon stream. A host that is away
 *   answers a create or attach with the `host-unavailable` failure a
 *   renderer waits out, as the daemon's did.
 * - **Claims**: a detached window's claim on a remote tab is
 *   the desktop's, and the proxy publishes the host's layout with it
 *   (`republishClaims`).
 *
 * A host not yet adopted — or one whose box has no host server — is still
 * the desktop's to answer for, as it always was: nothing routes to it.
 *
 * Electron-free: `createManorServer` composes it when the platform has
 * remote hosts.
 */

import type { AgentInfo } from "../agent-persistence";
import {
  HOST_PTY_EVENTS,
  type HostProgressEvent,
  type HostProxy,
  type HostPtyEvent,
} from "../backend/host-proxy";
import type { HostStatus } from "../backend/host-connection";
import { HostServerUnavailableError } from "../backend/host-server-client";
import { LOCAL_HOST_ID } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { Caller, RouteRule } from "../bridge/method";
import { declinesWake, stringsIn, wakesHost } from "../bridge/routes";
import type { BridgeForward } from "../bridge/server";
import {
  BridgeUnavailableRefusal,
  UNAVAILABLE_HOST_AWAY_CODE,
  UNAVAILABLE_HOST_CODE,
} from "../bridge/types";
import type { PendingCommands } from "../layout/pending-commands";
import type { RemoteProjects } from "../projects/types";
import type { BroadcastBus } from "../renderer-broadcast";
import { processAttachments, type PtyAttachments, type Viewer } from "../pty-attachments";
import type { PaneAgentStatusUpdate, PtyFailure, WinsizeOwnerEvent } from "../../src/electron.d";
import type { LayoutEntry, LayoutOrigin } from "../../src/lib/layout/protocol";
import { layoutPaneIds } from "../../src/lib/layout/workspace-layout";
import { parseWorkspaceKey, type WorkspaceKey } from "../../src/lib/workspace-key";

/** A control request's answer: its HTTP status and JSON body. */
export interface ControlAnswer {
  status: number;
  body: unknown;
}

export interface HostRoutingOptions {
  registry: {
    hostProxy(hostId: string): HostProxy | undefined;
    remoteHostIds(): string[];
    sessions: { ownerOf(sessionId: string): string | undefined };
    /** A host's connection status; `sleeping` is woken for a write. */
    status?(hostId: string): HostStatus | undefined;
    /** Wake a sleeping host and connect it (`BackendRegistry.wake`). */
    wake?(hostId: string): Promise<void>;
  };
  /** Whether `hostId` has adopted its records (`ProjectManager.isHostAdopted`). */
  isAdopted(hostId: string): boolean;
  /** Whether the desktop holds this project itself (it then answers for it). */
  hasLocalProject(projectId: string): boolean;
  /** The desktop's queue: a pane's command moves to the host that runs it. */
  pendingCommands: Pick<PendingCommands, "peek" | "take">;
  /** A forwarded project answer as the renderer sees it (its group). */
  decorateProject(result: unknown): unknown;
  /** The desktop's bus: progress to one caller, or everyone. */
  bus: Pick<BroadcastBus, "publish" | "publishTo">;
  /** Hand held records to a host's server (`HostAdoption.handOver`). */
  handOver(hostId: string, projectIds: readonly string[]): Promise<void>;
  /**
   * Who of the desktop's callers holds a remote pane, and owns its winsize
   * among them: the process's registry, unless a test that
   * runs a host server in this process gives main one of its own.
   */
  attachments?: PtyAttachments;
}

/** A caller, as the viewer the registry holds a pane under (`asViewer` in `bridge/handlers/pty.ts`). */
function viewerOf(caller: Caller): Viewer {
  return {
    connectionId: caller.id,
    callerClass: caller.callerClass,
    ...(caller.viewer !== undefined && { viewer: caller.viewer }),
  };
}

/** A pane's grid. */
interface Grid {
  cols: number;
  rows: number;
}

/** `cols×rows` off an answer or an event, when it has both. */
function gridOf(value: unknown): Grid | null {
  const { cols, rows } = (value ?? {}) as { cols?: unknown; rows?: unknown };
  return typeof cols === "number" && typeof rows === "number" && cols > 0 && rows > 0
    ? { cols, rows }
    : null;
}

/** What a layout command's origin is on the host: the desktop's caller. */
function originOf(caller: Caller): LayoutOrigin {
  return { kind: caller.callerClass === "local" ? "window" : "bridge", id: caller.id };
}

/**
 * Calls that clone or fetch, or run a setup's git, on the host: given as
 * long as a person would wait, not the owner channel's usual timeout.
 */
const LONG_CALLS = new Set([
  "projects.clone",
  "projects.createWorktree",
  "projects.removeWorktree",
  "projects.quickMergeWorktree",
  "projects.convertMainToWorktree",
  "projects.listRemoteBranches",
]);
const LONG_CALL_TIMEOUT_MS = 10 * 60_000;

function callTimeout(ns: string, method: string): { timeoutMs?: number } {
  return LONG_CALLS.has(`${ns}.${method}`) ? { timeoutMs: LONG_CALL_TIMEOUT_MS } : {};
}

/**
 * How long a write for a sleeping host waits for it to wake before it is
 * refused as away. A box slower than this goes on starting; the
 * next call finds it up.
 */
const WAKE_WAIT_MS = 2 * 60_000;

/** `pty` calls that leave the caller a viewer of the pane on the host. */
const PTY_ATTACHING = new Set(["create", "attach", "reset"]);

/**
 * What a forwarded `pty.<method>` answers while its host is away, where it
 * answers anything but a refusal: a create or attach fails the way a
 * renderer waits out (`host-unavailable`), as the daemon's did; a reset
 * fails plainly; and what a viewer does to its own view — resize, claim,
 * detach, close — is a no-op, as the handlers here make a failed one.
 * `write` is refused.
 */
function ptyAway(method: string, hostId: string, error: string): { value: unknown } | null {
  switch (method) {
    case "create":
    case "attach":
      return { value: { ok: false, reason: "host-unavailable", hostId, error } satisfies PtyFailure };
    case "reset":
      return { value: { ok: false, error } };
    case "claimWinsize":
      return { value: false };
    case "resize":
    case "detach":
    case "close":
      return { value: undefined };
    default:
      return null;
  }
}

/**
 * The bridge `wirePty` listens on: who is subscribed to a pane's events, and
 * the door that tells one connection its own `winsizeOwner`.
 */
export interface PtySubscriptions {
  onSubscriptionChange(cb: (name: string, key: string) => void): () => void;
  hasSubscriber(ns: string, event: string, key: string): boolean;
  publishTo(
    connectionId: string,
    ns: "pty",
    event: "winsizeOwner",
    args: [payload: WinsizeOwnerEvent],
    key: string,
  ): void;
}

/** Whether a forwarded `ns.method` changes the host's project records. */
function writesProjects(ns: string, method: string): boolean {
  if (ns === "linear") return true;
  return ns === "projects" && !/^(get|list|can)[A-Z]/.test(method);
}

/** The workspace paths of `project`, when it is a project. */
function workspacePathsOf(project: unknown): string[] {
  const workspaces = (project as { workspaces?: unknown } | null)?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  return workspaces.flatMap((ws) =>
    typeof (ws as { path?: unknown })?.path === "string" ? [(ws as { path: string }).path] : [],
  );
}

export class HostRouting implements BridgeForward {
  private readonly opts: HostRoutingOptions;
  /**
   * Who last asked each host for a workspace to be made or removed: where
   * that host's setup and teardown progress goes.
   */
  private readonly progressTo = new Map<string, string>();
  /**
   * Who made each workspace whose setup script may still be running, keyed
   * `<hostId>\0<path>`: its end, minutes later, goes back to them even if
   * someone else has made a workspace on that host since.
   */
  private readonly setupCallers = new Map<string, string>();
  /** The workspace a layout command last changed, here or on any host. */
  private lastActive: string | null = null;
  /**
   * Each pane event forwarded from a host, keyed `<event>\0<paneId>`: its
   * release, while a caller of the desktop's is subscribed to it.
   */
  private readonly ptyWatches = new Map<string, { hostId: string; release: () => void }>();
  /**
   * Remote panes the desktop's owner channel is a viewer of on their host:
   * a forwarded create, attach or reset made it one, and nobody here has
   * let go of it since.
   */
  private readonly ptyViewing = new Map<string, string>();
  /** The bridge `wirePty` listens on, once wired. */
  private ptySubscriptions: PtySubscriptions | null = null;
  /**
   * Who of the desktop's callers holds each remote pane, and which of them
   * owns its winsize here. The host decides only between the
   * desktop as a whole and its own viewers.
   */
  private readonly attachments: PtyAttachments;
  /**
   * Whether the host says the desktop's owner channel owns each remote
   * pane's winsize: its last answer to a create, attach or reset, or its
   * last `winsizeOwner` event.
   */
  private readonly hostOwns = new Map<string, boolean>();
  /** Each remote pane's grid, as its host last told it. */
  private readonly ptyGrids = new Map<string, Grid>();
  /** The pane a caller's own detach or close is releasing: the call forwards it, not `letGo`. */
  private releasing: string | null = null;

  constructor(opts: HostRoutingOptions) {
    this.opts = opts;
    this.attachments = opts.attachments ?? processAttachments;
  }

  // ── hosts ──

  /** `hostId`'s proxy, when its records are its server's; else null. */
  proxy(hostId: string): HostProxy | null {
    if (hostId === LOCAL_HOST_ID || !this.opts.isAdopted(hostId)) return null;
    return this.opts.registry.hostProxy(hostId) ?? null;
  }

  /** Every adopted host's proxy, in registration order. */
  proxies(): HostProxy[] {
    return this.opts.registry
      .remoteHostIds()
      .flatMap((hostId) => this.proxy(hostId) ?? []);
  }

  /** The proxy of the adopted host `paneId` runs on; null for the desktop's own panes. */
  proxyForPane(paneId: string): HostProxy | null {
    const hostId = this.hostOfPane(paneId);
    return hostId === null ? null : this.proxy(hostId);
  }

  // ── routing (BridgeForward) ──

  target(rule: RouteRule, args: readonly unknown[]): string | null {
    // A delegated call (Linear) rides the token this server holds.
    if (rule.by === "delegated") return null;
    const arg = args[rule.arg];
    switch (rule.by) {
      case "project":
        return typeof arg === "string" ? this.hostOfProject(arg) : null;
      case "workspaceKey":
        return typeof arg === "string" ? this.routable(parseWorkspaceKey(arg).hostId) : null;
      case "pane": {
        if (typeof arg !== "string") return null;
        const placed = this.hostOfPane(arg);
        if (placed !== null || rule.hostOpt === undefined) return placed;
        // A pane no layout holds yet: the host its create names.
        const opts = args[rule.hostOpt];
        const named =
          typeof opts === "object" && opts !== null ? (opts as { hostId?: unknown }).hostId : null;
        return typeof named === "string" ? this.routable(named) : null;
      }
      case "agent":
        return typeof arg === "string" ? this.hostOfAgent(arg) : null;
      case "host":
        return typeof arg === "string" ? this.routable(arg) : null;
      case "ghRepo": {
        const hostId =
          typeof arg === "object" && arg !== null ? (arg as { hostId?: unknown }).hostId : null;
        return typeof hostId === "string" ? this.routable(hostId) : null;
      }
    }
  }

  async invoke(
    hostId: string,
    ns: string,
    method: string,
    args: unknown[],
    caller: Caller,
  ): Promise<unknown> {
    const proxy = this.proxy(hostId);
    if (!proxy) {
      throw new BridgeUnavailableRefusal(`${hostId} is offline`, UNAVAILABLE_HOST_AWAY_CODE);
    }
    if (wakesHost(ns, method)) {
      // A pane restored at launch leaves its sleeping host asleep, and waits
      // behind the host's asleep banner.
      if (declinesWake(ns, method, args)) {
        const asleep = this.opts.registry.status?.(hostId) === "sleeping";
        const away = asleep ? ptyAway(method, hostId, `${proxy.label} is asleep`) : null;
        if (away) return away.value;
      } else {
        await this.wakeIfAsleep(hostId);
      }
    }
    let callArgs = args;
    try {
      if (ns === "layout" && method === "apply") {
        if (typeof args[0] === "string") this.lastActive = args[0];
        await this.movePendingCommands(proxy, args[1]);
        // The host records the desktop's caller as the command's origin, so
        // its broadcast's hint lands on the renderer that sent it.
        callArgs = [args[0], args[1], originOf(caller)];
      }
      const creating = ns === "projects" && method === "createWorktree";
      if (creating || (ns === "projects" && method === "removeWorktree")) {
        this.progressTo.set(hostId, caller.id);
      }
      if (ns === "projects" && method === "removeWorktree") {
        this.setupCallers.delete(`${hostId}\0${String(args[1])}`);
      }
      const before = creating ? this.workspacePaths(proxy, args[0]) : null;
      if (ns === "pty") return await this.invokePty(proxy, method, callArgs, caller);
      const result = await proxy.invoke(ns, method, callArgs, callTimeout(ns, method));
      if (before) {
        for (const path of workspacePathsOf(result)) {
          if (!before.has(path)) this.setupCallers.set(`${hostId}\0${path}`, caller.id);
        }
      }
      // A project write the host publishes nothing for (a rename, a folder)
      // is read back now, so the desktop's next list has it.
      if (writesProjects(ns, method)) await proxy.refreshProjects();
      if (ns !== "projects") return result;
      return Array.isArray(result)
        ? result.map((item) => this.opts.decorateProject(item))
        : this.opts.decorateProject(result);
    } catch (err) {
      throw this.refusal(proxy, err);
    }
  }

  /**
   * A remote pane's `pty.<method>` on its host's server. The
   * desktop's owner channel is the viewer there, for whichever caller of the
   * desktop's asked; the pane's events are watched for as long as one of
   * them is subscribed (`wirePty`).
   *
   * The host sees the desktop as one viewer, so the desktop decides among
   * its own callers first, with the same registry rules a pane
   * of its own has: a caller that would not own the pane here is sent the
   * host's grid, not its own; only the caller that owns it here resizes it;
   * and the host is detached only when no caller here holds the pane.
   */
  private async invokePty(
    proxy: HostProxy,
    method: string,
    args: unknown[],
    caller: Caller,
  ): Promise<unknown> {
    const paneId = args[0] as string;
    const viewer = viewerOf(caller);
    const reg = this.attachments;
    let callArgs = args;
    let follower = false;
    switch (method) {
      case "create":
      case "reset": {
        follower = !reg.wouldOwn(paneId, viewer);
        // A follower's grid is not its to give the session: the host's is.
        const grid = follower ? this.ptyGrids.get(paneId) : undefined;
        if (grid) callArgs = [args[0], args[1], grid.cols, grid.rows, ...args.slice(4)];
        break;
      }
      case "resize":
        // Not this caller's grid to move: answered, and dropped, as `ptyResize` does.
        if (reg.ownerOf(paneId)?.connectionId !== viewer.connectionId) return undefined;
        break;
      case "claimWinsize":
        if (!reg.claim(paneId, viewer)) return false;
        break;
      case "write":
        // Typing, not xterm answering a query (as `ptyWrite`).
        if (typeof args[1] === "string" && !args[1].startsWith("\x1b")) {
          reg.reclaimOnInput(paneId, viewer);
        }
        break;
      case "detach":
      case "close":
        this.releasing = paneId;
        try {
          reg.release(paneId, viewer);
        } finally {
          this.releasing = null;
        }
        // Another caller here still views it: the host's viewer stays.
        if (method === "detach" && reg.isHeld(paneId)) return undefined;
        break;
    }
    let result: unknown;
    try {
      result = await proxy.invoke("pty", method, callArgs);
    } catch (err) {
      if (!(err instanceof HostServerUnavailableError)) throw err;
      const away = ptyAway(method, proxy.hostId, errorMessage(this.refusal(proxy, err)));
      if (!away) throw err;
      return away.value;
    }
    if (PTY_ATTACHING.has(method)) {
      const answer = result as { ok?: unknown; winsizeOwner?: unknown } | null;
      if (answer?.ok === true) {
        this.ptyViewing.set(paneId, proxy.hostId);
        const hostOwns = answer.winsizeOwner !== false;
        this.hostOwns.set(paneId, hostOwns);
        const grid = gridOf(answer);
        if (grid) this.ptyGrids.set(paneId, grid);
        reg.attach(paneId, viewer, method === "attach" ? { as: "returning" } : {});
        const owns = !follower && reg.ownerOf(paneId)?.connectionId === viewer.connectionId;
        result = { ...answer, winsizeOwner: hostOwns && owns };
      }
      // Subscribed before the pane was known to be the host's: watch now.
      this.syncPtyWatches(paneId);
    } else if (method === "detach" || method === "close") {
      this.forgetPty(paneId);
    }
    return result;
  }

  /**
   * One of a remote pane's events from its host, before it goes on to the
   * desktop's callers (`HostProxyOptions.publishKeyed`). Its grid is noted;
   * and the host's `winsizeOwner`, which is about the desktop as a whole, is
   * told to each caller here with this side's answer for it.
   * Returns whether the event was delivered here, and so goes no further.
   */
  onHostPtyEvent(event: HostPtyEvent, args: readonly unknown[], paneId: string): boolean {
    if (event === "resized") {
      const [cols, rows] = args;
      const grid = gridOf({ cols, rows });
      if (grid) this.ptyGrids.set(paneId, grid);
      return false;
    }
    if (event !== "winsizeOwner") return false;
    const payload = args[0] as Partial<WinsizeOwnerEvent> | undefined;
    const grid = gridOf(payload);
    if (grid) this.ptyGrids.set(paneId, grid);
    this.hostOwns.set(paneId, payload?.owner === true);
    this.tellWinsizeOwners(paneId);
    return true;
  }

  /**
   * Tell each caller here that holds `paneId` whether it owns the grid: the
   * host must say the desktop does, and this side that the caller does.
   */
  private tellWinsizeOwners(paneId: string): void {
    const bridge = this.ptySubscriptions;
    const grid = this.ptyGrids.get(paneId);
    if (!bridge || !grid) return;
    const hostOwns = this.hostOwns.get(paneId) === true;
    const owner = this.attachments.ownerOf(paneId)?.connectionId;
    for (const { connectionId } of this.attachments.viewersOf(paneId)) {
      const owns = hostOwns && owner === connectionId;
      bridge.publishTo(connectionId, "pty", "winsizeOwner", [{ paneId, ...grid, owner: owns }], paneId);
    }
  }

  /**
   * Who owns a remote pane here moved: a caller attached, claimed, typed,
   * let go or dropped. Each caller left is told; and once none holds it,
   * the owner channel lets go of it on the host.
   */
  private onLocalOwnerChanged(paneId: string): void {
    if (!this.ptyViewing.has(paneId)) return;
    if (this.attachments.isHeld(paneId)) {
      this.tellWinsizeOwners(paneId);
    } else if (this.releasing !== paneId) {
      this.letGo(paneId);
    }
  }

  /** Nothing here views `paneId` on its host any more. */
  private forgetPty(paneId: string): void {
    this.ptyViewing.delete(paneId);
    this.hostOwns.delete(paneId);
  }

  /**
   * Forward each remote pane's `pty.*` events to the desktop's callers that
   * subscribe to them, through its host's proxy, for as long as
   * one of them is: `bridge` says who is. When the last caller here lets go
   * of a pane — it detached, or dropped without detaching, which releases
   * it (`BridgeServer.drop`) — the owner channel lets go of the pane on the
   * host, so a caller gone does not hold its winsize there; as it does when
   * nobody is left listening to its output and nobody holds it. Each
   * caller holding a pane is told its own `winsizeOwner`.
   * Returns the unwiring.
   */
  wirePty(bridge: PtySubscriptions): () => void {
    this.ptySubscriptions = bridge;
    const offOwners = this.attachments.onAttachmentChange((paneId) => this.onLocalOwnerChanged(paneId));
    const off = bridge.onSubscriptionChange((name, key) => {
      if (!name.startsWith("pty.")) return;
      if (!(HOST_PTY_EVENTS as readonly string[]).includes(name.slice(4))) return;
      this.syncPtyWatches(key);
      if (
        name === "pty.output" &&
        !bridge.hasSubscriber("pty", "output", key) &&
        !this.attachments.isHeld(key)
      ) {
        this.letGo(key);
      }
    });
    return () => {
      off();
      offOwners();
      this.ptySubscriptions = null;
      for (const { release } of this.ptyWatches.values()) release();
      this.ptyWatches.clear();
    };
  }

  /** Whether `paneId`'s output reaches this server through its host's proxy. */
  watchesPty(paneId: string): boolean {
    return this.ptyWatches.has(`output\0${paneId}`);
  }

  /** Hold exactly the watches `paneId`'s subscribers here want, on its host. */
  private syncPtyWatches(paneId: string): void {
    const bridge = this.ptySubscriptions;
    if (!bridge) return;
    const proxy = this.proxyForPane(paneId);
    for (const event of HOST_PTY_EVENTS) {
      const id = `${event}\0${paneId}`;
      const held = this.ptyWatches.get(id);
      const wanted = proxy !== null && bridge.hasSubscriber("pty", event, paneId);
      if (held && (!wanted || held.hostId !== proxy?.hostId)) {
        held.release();
        this.ptyWatches.delete(id);
      }
      if (wanted && !this.ptyWatches.get(id)) {
        this.ptyWatches.set(id, {
          hostId: proxy.hostId,
          release: proxy.watchPty(event as HostPtyEvent, paneId),
        });
      }
    }
  }

  /** Nobody here views `paneId` any more: the owner channel detaches on its host. */
  private letGo(paneId: string): void {
    const hostId = this.ptyViewing.get(paneId);
    if (hostId === undefined) return;
    this.forgetPty(paneId);
    const proxy = this.proxy(hostId);
    if (!proxy || proxy.away) return;
    proxy.invoke("pty", "detach", [paneId]).catch((err: unknown) => {
      console.debug(`[host-routing] detaching ${paneId} on ${proxy.label} failed:`, err);
    });
  }

  /**
   * A desktop window's claim moved on `key`, a remote workspace: its host's proxy publishes the layout again, with the claims.
   */
  republishClaims(key: string, origin: LayoutOrigin): void {
    const hostId = this.routable(parseWorkspaceKey(key).hostId);
    if (hostId === null) return;
    this.proxy(hostId)?.republishClaims(key as WorkspaceKey, origin);
  }

  /**
   * A control request (`electron/routes/`) for one of `hostId`'s projects or
   * agents, answered by its server's own routes (`hostServer.control`) —
   * the desktop's MCP and CLI reach an adopted host this way,
   * as the bridge does through `invoke`. The answer's records carry
   * `hostId`. Never rejects: a host that is away, or refuses, is a 503.
   */
  async control(
    hostId: string,
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<ControlAnswer> {
    const proxy = this.proxy(hostId);
    if (!proxy) return { status: 503, body: { error: `${hostId} is offline` } };
    if (method !== "GET") await this.wakeIfAsleep(hostId);
    try {
      const answer = (await proxy.invoke(
        "hostServer",
        "control",
        [method, path, body],
        // A write may clone, fetch or run a setup's git there.
        method === "GET" ? {} : { timeoutMs: LONG_CALL_TIMEOUT_MS },
      )) as ControlAnswer;
      // A write the host publishes nothing for is read back now, so the
      // desktop's next list has it.
      if (method !== "GET") await proxy.refreshProjects();
      const stamp = (value: unknown): unknown =>
        typeof value === "object" &&
        value !== null &&
        (value as { hostId?: unknown }).hostId === LOCAL_HOST_ID
          ? { ...value, hostId }
          : value;
      const out = answer?.body;
      return {
        status: typeof answer?.status === "number" ? answer.status : 502,
        body: Array.isArray(out) ? out.map(stamp) : stamp(out),
      };
    } catch (err) {
      const refusal = this.refusal(proxy, err);
      return {
        status: refusal instanceof BridgeUnavailableRefusal ? 503 : 502,
        body: { error: errorMessage(refusal) },
      };
    }
  }

  /**
   * Wake `hostId` if its box is asleep, and wait — at most
   * `WAKE_WAIT_MS` — for it to connect. Never rejects: a host that did not
   * wake in time, or could not, is away, and the call then refuses as for
   * any host away — "still starting" while its start goes on (`refusal`).
   */
  private async wakeIfAsleep(hostId: string): Promise<void> {
    const { registry } = this.opts;
    if (!registry.wake || registry.status?.(hostId) !== "sleeping") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        registry.wake(hostId),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, WAKE_WAIT_MS);
        }),
      ]);
    } catch (err) {
      console.warn(`[host-routing] waking ${hostId} failed:`, errorMessage(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A host that is away, or that refused, as the bridge answers it. A host
   * still coming up — a woken box whose start outlasted `WAKE_WAIT_MS`, a
   * recipe's `up` may take 15 minutes — is away, but says so.
   */
  private refusal(proxy: HostProxy, err: unknown): unknown {
    if (!(err instanceof HostServerUnavailableError)) return err;
    if (err.state === "refused") return new BridgeUnavailableRefusal(err.message, UNAVAILABLE_HOST_CODE);
    const starting = this.opts.registry.status?.(proxy.hostId) === "connecting";
    return new BridgeUnavailableRefusal(
      `${proxy.label} is ${starting ? "still starting" : "offline"}`,
      UNAVAILABLE_HOST_AWAY_CODE,
    );
  }

  /** `hostId` when calls for it go to its server; null when they stay here. */
  private routable(hostId: string): string | null {
    return this.proxy(hostId) ? hostId : null;
  }

  /** The adopted host whose server holds agent `agentId`; null for one of the desktop's. */
  private hostOfAgent(agentId: string): string | null {
    for (const proxy of this.proxies()) {
      if (proxy.agents().some((a) => a.id === agentId)) return proxy.hostId;
    }
    return null;
  }

  /** The adopted host whose server holds `projectId`; null if the desktop does. */
  private hostOfProject(projectId: string): string | null {
    if (this.opts.hasLocalProject(projectId)) return null;
    for (const proxy of this.proxies()) {
      if (proxy.projects().some((p) => p.id === projectId)) return proxy.hostId;
    }
    return null;
  }

  /**
   * The adopted host whose layout holds `paneId`, or whose session it is.
   * A pane no layout holds yet — one a command is about to add — is here's:
   * its pending command waits here until that command goes to a host.
   */
  private hostOfPane(paneId: string): string | null {
    const key = this.workspaceOfPane(paneId);
    if (key !== null) return this.routable(parseWorkspaceKey(key).hostId);
    const owner = this.opts.registry.sessions.ownerOf(paneId);
    return owner ? this.routable(owner) : null;
  }

  /**
   * Send the host the commands the desktop queued for panes `command`
   * adds: `layout.setPendingCommand` went out before the pane had a
   * workspace, so it landed here. Before the command itself, as the
   * renderer sent them.
   */
  private async movePendingCommands(proxy: HostProxy, command: unknown): Promise<void> {
    const { pendingCommands } = this.opts;
    for (const paneId of stringsIn(command)) {
      const pending = pendingCommands.peek(paneId);
      if (!pending || (pending.kind !== "shell" && pending.kind !== "agent-startup")) continue;
      pendingCommands.take(paneId);
      const opts = {
        submit: pending.submit,
        ...(pending.prompt !== undefined ? { prompt: pending.prompt } : {}),
      };
      await proxy.invoke("layout", "setPendingCommand", [paneId, pending.text, pending.kind, opts]);
    }
  }

  // ── what the host sends its owner ──

  /** A host's progress event, to whoever asked (`HostProxyOptions.onProgress`). */
  onProgress(hostId: string, event: HostProgressEvent, args: unknown[]): void {
    const { bus } = this.opts;
    const [payload] = args as [never];
    if (event === "cloneProgress") {
      bus.publish("projects", "cloneProgress", payload);
      return;
    }
    let to = this.progressTo.get(hostId) ?? null;
    const step = payload as { workspacePath?: unknown; status?: unknown } | undefined;
    if (event === "worktreeProgress" && typeof step?.workspacePath === "string") {
      const key = `${hostId}\0${step.workspacePath}`;
      const maker = this.setupCallers.get(key);
      if (maker !== undefined) {
        to = maker;
        if (step.status === "done" || step.status === "error") this.setupCallers.delete(key);
      }
    }
    bus.publishTo(to, "projects", event, payload);
  }

  /** The workspace paths `projectId` has on `proxy`'s host now. */
  private workspacePaths(proxy: HostProxy, projectId: unknown): Set<string> {
    const project = proxy.projects().find((p) => p.id === projectId);
    return new Set(workspacePathsOf(project));
  }

  // ── merged reads ──

  /** Every adopted host's agents, in the desktop's form. */
  agents(): AgentInfo[] {
    return this.proxies().flatMap((proxy) => proxy.agents());
  }

  /** Every adopted host's panes' last Agent statuses. */
  paneStatuses(): PaneAgentStatusUpdate[] {
    return this.proxies().flatMap((proxy) => proxy.paneStatuses());
  }

  /** Every adopted host's layout, keyed `<hostId>:<path>`. */
  layout(): Record<WorkspaceKey, LayoutEntry> {
    const out: Record<WorkspaceKey, LayoutEntry> = {};
    for (const proxy of this.proxies()) Object.assign(out, proxy.layout());
    return out;
  }

  /**
   * The workspace last changed: by a layout command this process saw, here
   * or forwarded; else `local`, the desktop's own; else a host's.
   */
  lastActiveWorkspace(local: string | null): string | null {
    if (this.lastActive !== null) return this.lastActive;
    if (local !== null) return local;
    for (const proxy of this.proxies()) {
      const key = proxy.lastActiveWorkspace();
      if (key !== null) return key;
    }
    return null;
  }

  /** A layout command run here: the workspace is the last active one. */
  noteActive(workspaceKey: string): void {
    this.lastActive = workspaceKey;
  }

  /** The remote workspace whose layout holds `paneId`, as a key; null if none. */
  workspaceOfPane(paneId: string): WorkspaceKey | null {
    for (const proxy of this.proxies()) {
      for (const [key, entry] of Object.entries(proxy.layout())) {
        if (layoutPaneIds(entry.layout).has(paneId)) return key as WorkspaceKey;
      }
    }
    return null;
  }

  /** The proxies' projects, for `ProjectManager`. */
  remoteProjects(): RemoteProjects {
    return {
      list: () => this.proxies().flatMap((proxy) => proxy.projects()),
      owns: (hostId) => this.proxy(hostId) !== null,
      call: async (hostId, method, args) => {
        const proxy = this.proxy(hostId);
        if (!proxy) {
          throw new BridgeUnavailableRefusal(`${hostId} is offline`, UNAVAILABLE_HOST_AWAY_CODE);
        }
        if (wakesHost("projects", method)) await this.wakeIfAsleep(hostId);
        let result: unknown;
        try {
          result = await proxy.invoke("projects", method, args, callTimeout("projects", method));
        } catch (err) {
          throw this.refusal(proxy, err);
        }
        // The next read here sees the change, not the list from before it.
        if (method === "selectWorkspace") {
          proxy.noteSelectedWorkspace(args[0] as string, args[1] as number);
        } else {
          await proxy.refreshProjects();
        }
        return result;
      },
      handOver: (hostId, projectIds) => this.opts.handOver(hostId, projectIds),
      layoutOf: (hostId) => this.proxy(hostId)?.layout() ?? {},
    };
  }
}
