/**
 * What the desktop pushes to each remote host's host server over the owner
 * channel (ADR-225 D3, D4), and when.
 *
 * - **The desktop's VAPID pair**, whole, after every connect of the owner
 *   channel — the first, and each after a host reconnect
 *   (`BackendRegistry.onHostServerStateChange` reporting `connected`) — so a
 *   phone's one browser subscription is valid in every room.
 * - **The host's push endpoints** are read back after it, and again whenever
 *   a phone is paired or revoked (`pairingChanged`): the desktop skips its
 *   own push to those for that host's agents.
 *
 * The host server owns its projects and layout (ADR-227 D2), so neither is
 * pushed any more. What the desktop still holds for a host is handed over
 * once, on adoption (ADR-227 D3): its layout in the shape
 * `hostLayoutSnapshot` builds, below.
 */

import type { LayoutEntry } from "../../src/lib/layout/protocol";
import { parseWorkspaceKey } from "../../src/lib/workspace-key";
import { errorMessage } from "../lib/errors";
import {
  HOST_LAYOUT_VERSION,
  type HostLayoutSnapshot,
} from "../host-server/layout";
import type { VapidKeys } from "../remote-control/push";
import { HostPushEndpoints } from "../remote-control/host-push-endpoints";
import type { HostServerClient, HostServerClientState } from "./host-server-client";

/** The registry's side of the push: each remote host's owner channel. */
export interface HostServerRegistry {
  hostServer(hostId: string): HostServerClient | undefined;
  hostServers(): HostServerClient[];
  onHostServerStateChange(
    listener: (hostId: string, state: HostServerClientState) => void,
  ): () => void;
}

export interface HostServerSyncOptions {
  registry: HostServerRegistry;
  /**
   * The desktop's VAPID pair, sent so the host server signs pushes with it
   * (D3). Null when it cannot be stored safely; nothing is sent then.
   */
  vapidKeys?(): Promise<VapidKeys | null>;
  log?: Pick<Console, "warn">;
}

export class HostServerSync {
  private readonly registry: HostServerRegistry;
  private readonly vapidKeys: (() => Promise<VapidKeys | null>) | undefined;
  private readonly log: Pick<Console, "warn">;
  private unsubscribe: (() => void) | null = null;
  /** The push endpoints each host's server sends to (ADR-225 D3). */
  private readonly endpoints: HostPushEndpoints;

  constructor(opts: HostServerSyncOptions) {
    this.registry = opts.registry;
    this.vapidKeys = opts.vapidKeys;
    this.endpoints = new HostPushEndpoints({
      status: async (hostId) => {
        const client = opts.registry.hostServer(hostId);
        return client?.state === "connected" ? client.api.hostServer.status() : null;
      },
    });
    this.log = opts.log ?? console;
  }

  /**
   * Send the key after every connect of a host's owner channel — channels
   * already up included.
   */
  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.registry.onHostServerStateChange((hostId, state) => {
      if (state === "connected") void this.sendAll(hostId);
      else if (state === "unsupported") this.endpoints.forget(hostId);
    });
    for (const client of this.registry.hostServers()) {
      if (client.state === "connected") void this.sendAll(client.hostId);
    }
  }

  /**
   * The push endpoints `hostId`'s server sends to; empty when unknown. The
   * desktop skips a phone's subscriptions to these for that host's agents.
   */
  pushEndpoints(hostId: string): ReadonlySet<string> {
    return this.endpoints.get(hostId);
  }

  /**
   * A phone was paired, revoked or the host's keys reset: ask the host for
   * its endpoints again. Resolves once the cache is current.
   */
  pairingChanged(hostId: string): Promise<void> {
    return this.endpoints.refresh(hostId);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async sendAll(hostId: string): Promise<void> {
    const client = this.registry.hostServer(hostId);
    if (!client) return;
    // A changed key clears the host's subscriptions, so its endpoints are
    // read only after the key is in.
    await this.pushVapidKeys(hostId, client);
    await this.endpoints.refresh(hostId);
  }

  /** Whole, every connect: idempotent on the server unless the key changed. */
  private async pushVapidKeys(hostId: string, client: HostServerClient): Promise<void> {
    if (!this.vapidKeys) return;
    try {
      const keys = await this.vapidKeys();
      if (keys) await client.api.hostServer.setVapidKeys(keys);
    } catch (err) {
      this.log.warn(`[host-server-sync] ${hostId}: setVapidKeys failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * The layout snapshot for `hostId`, for adoption (ADR-227 D3): the entries of
 * the desktop's layout (`LayoutStore.getAll()`, keyed `<hostId>:<path>` for a
 * remote workspace) that belong to `hostId`, rekeyed to their bare path, with
 * no window claims (a claim is a desktop window's, and means nothing on the
 * box). `lastActiveWorkspacePath` survives only when it is on this host. The
 * box's check (`host-server/owner.ts` `assertBareLayoutEntries`) must accept
 * what this builds.
 */
export function hostLayoutSnapshot(
  all: Readonly<Record<string, LayoutEntry>>,
  lastActive: string | null,
  hostId: string,
  takenAt: string,
): HostLayoutSnapshot {
  const workspaces: Record<string, LayoutEntry> = {};
  for (const [key, entry] of Object.entries(all)) {
    const parsed = parseWorkspaceKey(key);
    if (parsed.hostId !== hostId) continue;
    workspaces[parsed.path] = { ...entry, claims: [] };
  }
  let lastActiveWorkspacePath: string | null = null;
  if (lastActive !== null) {
    const parsed = parseWorkspaceKey(lastActive);
    if (parsed.hostId === hostId) lastActiveWorkspacePath = parsed.path;
  }
  return {
    version: HOST_LAYOUT_VERSION,
    takenAt,
    workspaces,
    lastActiveWorkspacePath,
  };
}

/** `hostLayoutSnapshot` over a layout store's current state. */
export function layoutSnapshotFor(
  hostId: string,
  store: {
    getAll(): Record<string, LayoutEntry>;
    getLastActiveWorkspacePath(): string | null;
  },
  now: Date = new Date(),
): HostLayoutSnapshot {
  return hostLayoutSnapshot(
    store.getAll(),
    store.getLastActiveWorkspacePath(),
    hostId,
    now.toISOString(),
  );
}
