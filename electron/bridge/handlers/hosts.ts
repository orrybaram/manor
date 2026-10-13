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
import { assertString } from "../../ipc-validate";
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
import type { PairResult } from "../../remote-control/relay-room";
import type { RemoteDeviceInfo } from "../../remote-control/devices";
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

export function hostsList(ctx: HandlerCtx): HostStatusInfo[] {
  return ctx.deps.backendRegistry.list();
}

export function hostsAdd(
  ctx: HandlerCtx,
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

export function hostsRetryConnect(ctx: HandlerCtx, hostId: string): void {
  assertString(hostId, "hosts:retryConnect.hostId");
  ctx.deps.backendRegistry.retryNow(hostId);
}

/** The ADR-178 (main) §4 checks, run through the host itself. */
export async function hostsHealthCheck(
  ctx: HandlerCtx,
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

// ── Phone access through a host's server (ADR-218 D3, D4, D6) ──

/** What the Remote Control page shows for one host's server. */
export interface HostServerView {
  state: HostServerClientState;
  /** Null unless the owner channel is up. */
  status: HostServerStatus | null;
}

/** The owner channel to `hostId`'s server, or a plain reason there is none. */
function serverClient(ctx: HandlerCtx, hostId: string): HostServerClient {
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
function connectedServer(ctx: HandlerCtx, hostId: string): HostServerClient {
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
function pairingChanged(ctx: HandlerCtx, hostId: string): void {
  void ctx.deps.hostServerSync.pairingChanged(hostId).then(() => {
    const client = ctx.deps.backendRegistry.hostServer(hostId);
    if (!client) return;
    publishRendererBroadcast("hosts", "serverChanged", {
      hostId,
      state: client.state,
    });
  });
}

export async function hostsServerStatus(
  ctx: HandlerCtx,
  hostId: string,
): Promise<HostServerView> {
  const client = serverClient(ctx, hostId);
  if (client.state !== "connected") return { state: client.state, status: null };
  try {
    const status = await client.api.hostServer.status();
    return { state: client.state, status };
  } catch (err) {
    if (err instanceof HostServerUnavailableError) {
      return { state: client.state, status: null };
    }
    throw err;
  }
}

export async function hostsPairDevice(
  ctx: HandlerCtx,
  hostId: string,
  label?: string,
): Promise<PairResult> {
  const client = connectedServer(ctx, hostId);
  const name = typeof label === "string" && label.trim() !== "" ? label.trim() : "Phone";
  const result = await client.api.remoteControl.pair(name);
  pairingChanged(ctx, hostId);
  return result;
}

export async function hostsListDevices(
  ctx: HandlerCtx,
  hostId: string,
): Promise<RemoteDeviceInfo[]> {
  return await connectedServer(ctx, hostId).api.remoteControl.listDevices();
}

export async function hostsRevokeDevice(
  ctx: HandlerCtx,
  hostId: string,
  deviceId: string,
): Promise<RemoteDeviceInfo[]> {
  assertString(deviceId, "hosts:revokeDevice.deviceId");
  const devices = await connectedServer(ctx, hostId).api.remoteControl.revoke(deviceId);
  pairingChanged(ctx, hostId);
  return devices;
}

export async function hostsResetPairingKeys(
  ctx: HandlerCtx,
  hostId: string,
): Promise<HostServerStatus> {
  const status = await connectedServer(ctx, hostId).api.hostServer.resetIdentity();
  pairingChanged(ctx, hostId);
  return status;
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
  deps: Pick<HostDeps, "backendRegistry">,
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
  healthCheck: method(hostsHealthCheck),
  // Pairing a phone with a host's server hands out a key to that host, so
  // these are `localOnly` like `remoteControl.pair` (ADR-218 D3).
  serverStatus: method(hostsServerStatus, { localOnly: true }),
  pairDevice: method(hostsPairDevice, { localOnly: true, mutating: true }),
  listDevices: method(hostsListDevices, { localOnly: true }),
  revokeDevice: method(hostsRevokeDevice, { localOnly: true, mutating: true }),
  resetPairingKeys: method(hostsResetPairingKeys, {
    localOnly: true,
    mutating: true,
  }),
};
