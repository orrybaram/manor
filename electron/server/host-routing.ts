/**
 * The desktop as a client of each host server (ADR-227 D4).
 *
 * Once a remote host has adopted its records (D3), its projects, layout and
 * agents are its server's. The desktop reaches them only through that
 * host's `HostProxy`, and this is where it does:
 *
 * - **Routing** (`BridgeForward`). A bridge method that names its host in
 *   an argument (`route` in its rules, `../bridge/method.ts`) and names an
 *   adopted remote host is answered by that host's server: the proxy
 *   rewrites the arguments and the answer, and a host that is away refuses
 *   with `unavailable:host-away` ("wsl-box is offline"). Nothing is queued.
 * - **Merged reads.** The proxies' projects (for `ProjectManager`, as
 *   `RemoteProjects`), layouts, agents and pane statuses, which the shared reads add to the
 *   desktop's own — the cache's while a host is away.
 * - **What a forwarded call carries along.** A layout command takes the
 *   calling renderer's origin, so its selection hint lands back on that
 *   renderer, and the pending command of any pane it adds, which the
 *   renderer queued a moment before without knowing the pane's host. Setup
 *   and teardown progress the host sends its owner goes back to whoever
 *   asked.
 * - **Starting a session** (`spawnSession`, `RoutedBackend`'s
 *   `SpawnOnHost`): the host's server spawns a remote pane's session and
 *   types its pending command; the desktop attaches over the daemon stream.
 *
 * A host not yet adopted — or one whose box has no host server — is still
 * the desktop's to answer for, as it always was: nothing routes to it.
 *
 * Electron-free: `createManorServer` composes it when the platform has
 * remote hosts.
 */

import type { AgentInfo } from "../agent-persistence";
import type { HostProgressEvent, HostProxy } from "../backend/host-proxy";
import { HostServerUnavailableError } from "../backend/host-server-client";
import { LOCAL_HOST_ID } from "../backend/types";
import { errorMessage } from "../lib/errors";
import type { Caller, RouteRule } from "../bridge/method";
import type { BridgeForward } from "../bridge/server";
import {
  BridgeUnavailableRefusal,
  UNAVAILABLE_HOST_AWAY_CODE,
  UNAVAILABLE_HOST_CODE,
} from "../bridge/types";
import type { PendingCommands } from "../layout/pending-commands";
import type { RemoteProjects } from "../projects/types";
import type { BroadcastBus } from "../renderer-broadcast";
import type { PaneAgentStatusUpdate, PtyCreateResult } from "../../src/electron.d";
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
}

/** What a layout command's origin is on the host: the desktop's caller. */
function originOf(caller: Caller): LayoutOrigin {
  return { kind: caller.callerClass === "local" ? "window" : "bridge", id: caller.id };
}

/** Every string in `value`, however deep: a command's pane ids among them. */
function stringsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) stringsIn(item, out);
  }
  return out;
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

/** Whether a forwarded `ns.method` changes the host's project records. */
function writesProjects(ns: string, method: string): boolean {
  if (ns === "linear") return true;
  return ns === "projects" && !/^(get|list|can)[A-Z]/.test(method);
}

export class HostRouting implements BridgeForward {
  private readonly opts: HostRoutingOptions;
  /**
   * Who last asked each host for a workspace to be made or removed: where
   * that host's setup and teardown progress goes.
   */
  private readonly progressTo = new Map<string, string>();
  /** The workspace a layout command last changed, here or on any host. */
  private lastActive: string | null = null;

  constructor(opts: HostRoutingOptions) {
    this.opts = opts;
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
    const arg = args[rule.arg];
    switch (rule.by) {
      case "project":
        return typeof arg === "string" ? this.hostOfProject(arg) : null;
      case "workspaceKey":
        return typeof arg === "string" ? this.routable(parseWorkspaceKey(arg).hostId) : null;
      case "pane":
        return typeof arg === "string" ? this.hostOfPane(arg) : null;
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
    let callArgs = args;
    try {
      if (ns === "layout" && method === "apply") {
        if (typeof args[0] === "string") this.lastActive = args[0];
        await this.movePendingCommands(proxy, args[1]);
        // The host records the desktop's caller as the command's origin, so
        // its broadcast's hint lands on the renderer that sent it.
        callArgs = [args[0], args[1], originOf(caller)];
      }
      if (ns === "projects" && (method === "createWorktree" || method === "removeWorktree")) {
        this.progressTo.set(hostId, caller.id);
      }
      const result = await proxy.invoke(ns, method, callArgs, callTimeout(ns, method));
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
   * A control request (`electron/routes/`) for one of `hostId`'s projects or
   * agents, answered by its server's own routes (`hostServer.control`,
   * ADR-227 D8) — the desktop's MCP and CLI reach an adopted host this way,
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

  /** A host that is away, or that refused, as the bridge answers it. */
  private refusal(proxy: HostProxy, err: unknown): unknown {
    if (!(err instanceof HostServerUnavailableError)) return err;
    return err.state === "refused"
      ? new BridgeUnavailableRefusal(err.message, UNAVAILABLE_HOST_CODE)
      : new BridgeUnavailableRefusal(`${proxy.label} is offline`, UNAVAILABLE_HOST_AWAY_CODE);
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

  // ── the control plane ──

  /**
   * Start `sessionId` on `hostId`'s server (`SpawnOnHost`): true when it
   * spawned it, false when it was running already, null when that is not
   * its server's to do — not adopted, away, or a failure, which is logged —
   * and the daemon creates it as before.
   */
  async spawnSession(
    hostId: string,
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    env: Record<string, string> | undefined,
  ): Promise<boolean | null> {
    const proxy = this.proxy(hostId);
    if (!proxy || proxy.away) return null;
    let result: PtyCreateResult;
    try {
      result = (await proxy.invoke("pty", "create", [
        sessionId,
        cwd,
        cols,
        rows,
        { hostId, agentKind: env?.MANOR_AGENT_KIND ?? null },
      ])) as PtyCreateResult;
    } catch (err) {
      console.warn(`[host-routing] ${proxy.label} could not start ${sessionId}:`, err);
      return null;
    }
    if (!result?.ok) {
      console.warn(`[host-routing] ${proxy.label} could not start ${sessionId}:`, result);
      return null;
    }
    // The host's `prewarmed` is whether its create found the session there.
    return result.prewarmed === false;
  }

  // ── what the host sends its owner ──

  /** A host's progress event, to whoever asked (`HostProxyOptions.onProgress`). */
  onProgress(hostId: string, event: HostProgressEvent, args: unknown[]): void {
    const { bus } = this.opts;
    const [payload] = args as [never];
    if (event === "cloneProgress") bus.publish("projects", "cloneProgress", payload);
    else bus.publishTo(this.progressTo.get(hostId) ?? null, "projects", event, payload);
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

  /** The proxies' projects, for `ProjectManager` (ADR-227 D4). */
  remoteProjects(): RemoteProjects {
    return {
      list: () => this.proxies().flatMap((proxy) => proxy.projects()),
      owns: (hostId) => this.proxy(hostId) !== null,
      call: async (hostId, method, args) => {
        const proxy = this.proxy(hostId);
        if (!proxy) {
          throw new BridgeUnavailableRefusal(`${hostId} is offline`, UNAVAILABLE_HOST_AWAY_CODE);
        }
        let result: unknown;
        try {
          result = await proxy.invoke("projects", method, args, callTimeout("projects", method));
        } catch (err) {
          throw this.refusal(proxy, err);
        }
        // The next read here sees the change, not the list from before it.
        await proxy.refreshProjects();
        return result;
      },
      handOver: (hostId, projectIds) => this.opts.handOver(hostId, projectIds),
    };
  }
}
