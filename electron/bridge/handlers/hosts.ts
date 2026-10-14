/**
 * Remote hosts (ADR-160 ticket 11): listing every host and its connection
 * status, adding one, retrying a stuck connection, and checking one's tools
 * against a project (moved from `ipc/projects.ts` on main, ADR-183).
 *
 * One namespace table (ADR-182 D3), so a renderer window and a paired
 * `full` device reach the same code. Thin by
 * design: every decision about what a host's state means, and what adding one
 * does, lives in `BackendRegistry` and `ProjectManager`. This only validates
 * the boundary and wires the two together.
 */

import crypto from "node:crypto";
import { assertBoolean, assertString } from "../../ipc-validate";
import { assertValidTarget } from "../../terminal-host/ssh-config";
import type { HostStatusInfo } from "../../backend/registry";
import {
  runHealthChecks,
  type HealthCheckResult,
} from "../../backend/health-check";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import {
  HostServerUnavailableError,
  type HostServerClient,
  type HostServerClientState,
} from "../../backend/host-server-client";
import type { HostServerStatus } from "../../host-server/relay";
import { serverFactsOf } from "../../backend/host-server-sync";
import type { PairResult } from "../../remote-control/relay-room";
import type { RemoteDeviceInfo } from "../../remote-control/devices";
import type { ServerDeps } from "../../ipc/types";
import { LOCAL_ROUTE, method, type HandlerCtx } from "../method";

/**
 * Every host and its connection status — with, for a remote host, its
 * server's relay room and whether it takes desktop viewer streams, from the
 * last status read (ADR-228 D2, D3; `HostServerSync`).
 */
export function hostsList(ctx: HandlerCtx<ServerDeps>): HostStatusInfo[] {
  return ctx.deps.backendRegistry.list();
}

export function hostsAdd(
  ctx: HandlerCtx<ServerDeps>,
  target: string,
): { hostId: string; spec: { kind: "ssh"; target: string } } {
  const { deps } = ctx;
  assertString(target, "hosts:add.target");
  const trimmed = target.trim();
  if (trimmed === "") {
    throw new Error("An ssh target is required.");
  }
  assertValidTarget(trimmed);
  const hostId = crypto.randomUUID();
  const spec = { kind: "ssh" as const, target: trimmed };
  deps.projectManager.saveHost(hostId, spec);
  deps.backendRegistry.register(hostId, spec);
  deps.backendRegistry.connectInBackground(hostId);
  return { hostId, spec };
}

export function hostsRetryConnect(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): void {
  assertString(hostId, "hosts:retryConnect.hostId");
  ctx.deps.backendRegistry.retryNow(hostId);
}

/**
 * How long `hosts.wake` waits for the host to come up before answering
 * anyway: a box that takes longer goes on starting, and its status says how
 * far it got (ADR-229 D1).
 */
const HOST_WAKE_WAIT_MS = 2 * 60_000;

/**
 * Wake `hostId` and connect it (ADR-229 D1). Answers once it is connected,
 * or after `HOST_WAKE_WAIT_MS` with the box still starting; rejects when it
 * cannot be brought up. A host that is awake already answers at once.
 */
async function hostsWake(ctx: HandlerCtx<ServerDeps>, hostId: string): Promise<void> {
  assertString(hostId, "hosts:wake.hostId");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ctx.deps.backendRegistry.wake(hostId),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HOST_WAKE_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Put `hostId`'s box to sleep (ADR-229 D1). Refused for a host whose
 * provider cannot stop it — every ssh box.
 */
async function hostsStop(ctx: HandlerCtx<ServerDeps>, hostId: string): Promise<void> {
  assertString(hostId, "hosts:stop.hostId");
  await ctx.deps.backendRegistry.stop(hostId);
}

/** The ADR-178 (main) §4 checks, run through the host itself. */
export async function hostsHealthCheck(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  projectPath: string,
): Promise<HealthCheckResult[]> {
  const { deps } = ctx;
  assertString(hostId, "hosts:healthCheck.hostId");
  assertString(projectPath, "hosts:healthCheck.projectPath");
  deps.projectManager.assertKnownHost(hostId);
  const { shell, git } = deps.backendRegistry.get(hostId);
  return runHealthChecks(shell, git, projectPath);
}

// ── Phone access through a host's server (ADR-225 D3, D4, D6) ──

/** What the Remote Control page shows for one host's server. */
export interface HostServerView {
  state: HostServerClientState;
  /** Null unless the owner channel is up. */
  status: HostServerStatus | null;
  /** Paired phones, read with the status so the two can never disagree. */
  devices: RemoteDeviceInfo[];
  /**
   * "Phones paired with this Mac can reach <host>" (ADR-228 D9): whether
   * this desktop's devices are paired here too. On by default.
   */
  linkPhones: boolean;
  /** The ids, among `devices`, of pairings this desktop minted ("via This Mac"). */
  linkedDeviceIds: string[];
}

/** The owner channel to `hostId`'s server, or a plain reason there is none. */
function serverClient(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): HostServerClient {
  assertString(hostId, "hosts:server.hostId");
  const client = ctx.deps.backendRegistry.hostServer(hostId);
  if (!client) {
    throw new Error(
      hostId === "local"
        ? "This computer has no host server; phone access is set up in Remote control."
        : `Unknown remote host ${hostId}.`,
    );
  }
  return client;
}

/** A client that can be called now, or the error saying why not. */
function connectedServer(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): HostServerClient {
  const client = serverClient(ctx, hostId);
  if (client.state === "unsupported") {
    throw new Error(
      "Phone access isn't available on this host: it has no Manor server yet. It is set up when the host reconnects.",
    );
  }
  if (client.state !== "connected") {
    throw new Error(
      "Phone access needs the host to reconnect first. Try again once it is back.",
    );
  }
  return client;
}

/** Have the sync re-read the host's push endpoints, then tell the page its pairing changed. */
function pairingChanged(ctx: HandlerCtx<ServerDeps>, hostId: string): void {
  void Promise.resolve(ctx.deps.hostServerSync?.pairingChanged(hostId)).then(() => {
    publishRendererBroadcast("hosts", "pairingChanged", hostId);
  });
}

export async function hostsServerStatus(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): Promise<HostServerView> {
  const client = serverClient(ctx, hostId);
  const { state } = client;
  const links = {
    linkPhones: ctx.deps.projectManager.hostLinksPhones(hostId),
    linkedDeviceIds: ctx.deps.hostLinks?.linkedOn(hostId) ?? [],
  };
  if (state !== "connected") return { state, status: null, devices: [], ...links };
  try {
    const [status, devices] = await Promise.all([
      client.api.hostServer.status(),
      client.api.remoteControl.listDevices(),
    ]);
    // A fresh read: keep `hosts.list`'s room and capability current with it.
    ctx.deps.backendRegistry.setServerFacts(hostId, serverFactsOf(status));
    return { state, status, devices, ...links };
  } catch (err) {
    if (err instanceof HostServerUnavailableError) {
      return { state, status: null, devices: [], ...links };
    }
    throw err;
  }
}

export async function hostsPairDevice(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  label?: string,
): Promise<PairResult> {
  const client = connectedServer(ctx, hostId);
  const name = typeof label === "string" && label.trim() !== "" ? label.trim() : "Phone";
  const result = await client.api.remoteControl.pair(name);
  pairingChanged(ctx, hostId);
  return result;
}

export async function hostsRevokeDevice(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  deviceId: string,
): Promise<RemoteDeviceInfo[]> {
  assertString(deviceId, "hosts:revokeDevice.deviceId");
  const devices = await connectedServer(ctx, hostId).api.remoteControl.revoke(deviceId);
  pairingChanged(ctx, hostId);
  return devices;
}

export async function hostsResetPairingKeys(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): Promise<HostServerStatus> {
  const status = await connectedServer(ctx, hostId).api.hostServer.resetIdentity();
  pairingChanged(ctx, hostId);
  return status;
}

/**
 * "Use Linear on <host>" (ADR-227 D7): copy this computer's Linear key to the
 * host's server, or delete the copy. The key goes over the owner channel to
 * the host's own `SecretBox`; it is never returned or logged. Answers whether
 * Linear is on for the host afterwards.
 */
export async function hostsSetLinearOnHost(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  on: boolean,
): Promise<boolean> {
  if (typeof on !== "boolean") throw new Error("hosts:setLinearOnHost.on must be a boolean");
  const client = connectedServer(ctx, hostId);
  let token: string | null = null;
  if (on) {
    token = ctx.deps.linearManager.getToken();
    if (token === null) throw new Error("Connect Linear on this computer first.");
  }
  const enabled = await client.api.hostServer.setLinearToken(token);
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
  return enabled;
}

/**
 * "Phones paired with this Mac can reach <host>" (ADR-228 D9). Off revokes
 * every pairing this desktop minted there — now, or on the host's next
 * connect — and `remoteControl.linkHostPairings` mints none there again
 * until it is back on. Allowed with the host away: that is when the revoke
 * has to wait.
 */
export async function hostsSetLinkPhones(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  on: boolean,
): Promise<void> {
  assertString(hostId, "hosts:setLinkPhones.hostId");
  assertBoolean(on, "hosts:setLinkPhones.on");
  serverClient(ctx, hostId);
  const links = ctx.deps.hostLinks;
  if (links) await links.setLinkPhones(hostId, on);
  else ctx.deps.projectManager.setHostLinksPhones(hostId, on);
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
}

/**
 * Wire the two host broadcasts, once, at boot (`app-lifecycle.ts`).
 *
 * `hosts.statusChanged` carries the full host list whenever any host's status
 * changes, so the settings panel and the status-bar indicator can never
 * disagree about a host's state. `hosts.reconnected` says a remote host came
 * back from a drop and its hooks replayed: every renderer reattaches its
 * panes there and recovers the ones whose sessions are gone (ADR-178 §6 on
 * main) — each acting only on the panes it has, a browser as much as a
 * window (ADR-180 D5).
 */
export function wireHostBroadcasts(
  deps: Pick<ServerDeps, "backendRegistry">,
): void {
  deps.backendRegistry.onStatusChange((hosts: HostStatusInfo[]) => {
    publishRendererBroadcast("hosts", "statusChanged", hosts);
  });
  deps.backendRegistry.onHostServerStateChange((hostId, state) => {
    publishRendererBroadcast("hosts", "serverChanged", { hostId, state });
  });
  deps.backendRegistry.onHostResumed((hostId, sessionIds) => {
    publishRendererBroadcast("hosts", "reconnected", { hostId, sessionIds });
  });
}

/**
 * The host list and its connection statuses, and the health check, are reads.
 * `add` registers an ssh target and connects to it with this machine's ssh
 * config and keys; `retryConnect` kicks a stuck connection. Neither is
 * `localOnly`: a `full` device already reaches this machine's shell through
 * `pty.*` (ADR-178 D3), so pointing ssh somewhere is not a new grant — but
 * both change what every viewer's host list shows, so both are `mutating`.
 */
export const hosts = {
  list: method(hostsList),
  add: method(hostsAdd, { mutating: true }),
  retryConnect: method(hostsRetryConnect, { mutating: true }),
  // A phone wakes a sleeping host through its home desktop (ADR-229 D7), so
  // `wake` is a `full` device's too: like `retryConnect`, it only connects
  // a host already listed here. Stopping one is the desktop user's call,
  // so `stop` is local. Both are home's to answer (`ROUTES`).
  wake: method(hostsWake, { mutating: true, route: LOCAL_ROUTE }),
  stop: method(hostsStop, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  healthCheck: method(hostsHealthCheck),
  // Pairing a phone with a host's server hands out a key to that host, so
  // these are `localOnly` like `remoteControl.pair` (ADR-225 D3).
  serverStatus: method(hostsServerStatus, { localOnly: true }),
  pairDevice: method(hostsPairDevice, { localOnly: true, mutating: true }),
  revokeDevice: method(hostsRevokeDevice, { localOnly: true, mutating: true }),
  resetPairingKeys: method(hostsResetPairingKeys, {
    localOnly: true,
    mutating: true,
  }),
  // Sends the Linear key to the host. `mutating` is safe for the audit line:
  // its arguments are the host id and a flag; the key is read here.
  setLinearOnHost: method(hostsSetLinearOnHost, { localOnly: true, mutating: true }),
  // Turning it off revokes phones on the host; on lets the desktop pair its
  // own there. The same grant as `pairDevice`, so local too (ADR-228 D9).
  setLinkPhones: method(hostsSetLinkPhones, { localOnly: true, mutating: true }),
};
