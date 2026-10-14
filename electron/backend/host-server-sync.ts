/**
 * What the desktop pushes to each remote host's host server over the owner
 * channel (ADR-225 D3, D4), and when.
 *
 * - **The desktop's VAPID pair**, whole, after every connect of the owner
 *   channel — the first, and each after a host reconnect
 *   (`BackendRegistry.onHostServerStateChange` reporting `connected`) — so a
 *   phone's one browser subscription is valid in every room.
 * - **Adoption** (ADR-227 D3), after the key: what the desktop still holds
 *   for the host — its projects, agents and layout, the layout in the shape
 *   `hostLayoutSnapshot` builds, below — handed to the host's server and
 *   then let go of (`./host-adoption.ts`). Once a host is adopted, this is
 *   one status read.
 * - **The host's push endpoints** are read back after it, and again whenever
 *   a phone is paired or revoked (`pairingChanged`): the desktop skips its
 *   own push to those for that host's agents. The same status read gives
 *   the host's relay room and whether it takes desktop viewer streams
 *   (ADR-228 D2, D3), which `hosts.list` carries.
 * - **Owed revokes** (ADR-228 D9): a pairing this desktop minted on the host
 *   for one of its own devices, whose revoke could not reach the host —
 *   the device was revoked, or "Phones paired with this Mac can reach" turned
 *   off, while the host was away. Stored on the host's record, and revoked
 *   on the next connect, before the endpoints are read.
 *
 * The host server owns its projects and layout (ADR-227 D2), so neither is
 * pushed any more.
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
import { hasViewerBridge } from "../host-server/capabilities";
import type { HostServerStatus } from "../host-server/relay";
import type { HostAdoption } from "./host-adoption";
import type { HostServerFacts } from "./host-connection";
import type { HostServerClient, HostServerClientState } from "./host-server-client";

/** The registry's side of the push: each remote host's owner channel. */
export interface HostServerRegistry {
  hostServer(hostId: string): HostServerClient | undefined;
  hostServers(): HostServerClient[];
  onHostServerStateChange(
    listener: (hostId: string, state: HostServerClientState) => void,
  ): () => void;
  /**
   * Record what a host's server said in its last status (ADR-228 D2, D3), so
   * `hosts.list` carries its room and whether it takes viewer streams.
   * Optional: a registry that does not list hosts has nowhere to put them.
   */
  setServerFacts?(hostId: string, facts: HostServerFacts | null): void;
}

/**
 * The facts `hosts.list` carries, from one status (ADR-228 D2, D3). A host
 * still waiting to be adopted takes no viewer stream yet (main refuses one,
 * `electron/ipc/host-pipe.ts`), so it does not say it does: a window would
 * only dial it to be turned away.
 */
export function serverFactsOf(
  status: Pick<HostServerStatus, "roomId" | "capabilities" | "relay"> &
    Partial<Pick<HostServerStatus, "ownership">>,
): HostServerFacts {
  return {
    // A server from before ADR-228 has no top-level `roomId`; its relay's is
    // the same room.
    roomId: status.roomId !== undefined ? status.roomId : (status.relay?.roomId ?? null),
    viewerBridge: hasViewerBridge(status) && status.ownership !== "pending",
  };
}

/**
 * The linked pairings each host is owed a revoke of (ADR-228 D9), by the
 * host's own device id: `PersistedHost.pendingRevokes`, through
 * `ProjectManager`.
 */
export interface PendingRevokes {
  list(hostId: string): readonly string[];
  /** `hostDeviceIds` were revoked on `hostId`. */
  clear(hostId: string, hostDeviceIds: readonly string[]): void;
  /** Some were: the host's phone list changed. */
  revoked?(hostId: string): void;
}

export interface HostServerSyncOptions {
  registry: HostServerRegistry;
  /**
   * The desktop's VAPID pair, sent so the host server signs pushes with it
   * (D3). Null when it cannot be stored safely; nothing is sent then.
   */
  vapidKeys?(): Promise<VapidKeys | null>;
  /** Hands each host's records to its server (ADR-227 D3). */
  adoption?: Pick<HostAdoption, "run">;
  /** Revokes owed to each host, sent on every connect (ADR-228 D9). */
  pendingRevokes?: PendingRevokes;
  log?: Pick<Console, "warn">;
}

export class HostServerSync {
  private readonly registry: HostServerRegistry;
  private readonly vapidKeys: (() => Promise<VapidKeys | null>) | undefined;
  private readonly adoption: Pick<HostAdoption, "run"> | undefined;
  private readonly pending: PendingRevokes | undefined;
  private readonly log: Pick<Console, "warn">;
  private unsubscribe: (() => void) | null = null;
  /** The push endpoints each host's server sends to (ADR-225 D3). */
  private readonly endpoints: HostPushEndpoints;

  constructor(opts: HostServerSyncOptions) {
    this.registry = opts.registry;
    this.vapidKeys = opts.vapidKeys;
    this.adoption = opts.adoption;
    this.pending = opts.pendingRevokes;
    this.endpoints = new HostPushEndpoints({
      // The one status read per connect and pairing change: its room and
      // capabilities are recorded for `hosts.list` on the way past.
      status: async (hostId) => {
        const client = opts.registry.hostServer(hostId);
        if (client?.state !== "connected") return null;
        const status = await client.api.hostServer.status();
        opts.registry.setServerFacts?.(hostId, serverFactsOf(status));
        return status;
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
      else if (state === "unsupported") {
        this.endpoints.forget(hostId);
        // No host server on the box: no room, no viewer streams.
        this.registry.setServerFacts?.(hostId, null);
      }
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

  /**
   * Revoke what `hostId` is owed, now if its owner channel is up; whatever
   * does not go through stays owed for the next connect. Resolves once the
   * endpoint cache is current again, if anything was revoked.
   */
  async revokePending(hostId: string): Promise<void> {
    const pending = this.pending;
    const client = this.registry.hostServer(hostId);
    if (!pending || client?.state !== "connected") return;
    const owed = pending.list(hostId);
    if (owed.length === 0) return;
    const done: string[] = [];
    for (const id of owed) {
      try {
        // A device the host no longer has (its keys were reset) revokes as
        // a no-op, and is no longer owed either.
        await client.api.remoteControl.revoke(id);
        done.push(id);
      } catch (err) {
        this.log.warn(`[host-server-sync] ${hostId}: revoke failed: ${errorMessage(err)}`);
      }
    }
    if (done.length === 0) return;
    pending.clear(hostId, done);
    await this.endpoints.refresh(hostId);
    pending.revoked?.(hostId);
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
    await this.adopt(hostId, client);
    await this.revokePending(hostId);
    await this.endpoints.refresh(hostId);
  }

  /** Every connect: a status read, and a hand-over when one is owed. */
  private async adopt(hostId: string, client: HostServerClient): Promise<void> {
    if (!this.adoption) return;
    try {
      await this.adoption.run(hostId, client);
    } catch (err) {
      this.log.warn(`[host-server-sync] ${hostId}: adoption failed: ${errorMessage(err)}`);
    }
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
