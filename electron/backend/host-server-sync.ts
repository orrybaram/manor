/**
 * What the desktop pushes to each remote host's host server over the owner
 * channel (ADR-218 D4, D5, D8), and when.
 *
 * **The manifest** (`buildHostManifest`) is that host's projects as
 * `projects.json` holds them, `hostId` rewritten to `local`, plus an
 * integration snapshot: each workspace's linked issue and its PR as the
 * desktop last saw them. Built from memory only — `ProjectManager`'s
 * records and last worktree listings, `GitHubManager`'s last-seen PRs — so
 * building one never costs a call to GitHub, Linear or the box.
 *
 * **The layout** (`hostLayoutSnapshot`) is that host's workspaces out of
 * the `LayoutStore`, rekeyed from `<hostId>:<path>` to the bare path.
 *
 * **When** (`HostServerSync`):
 * - both, whole, after every connect of the owner channel — the first, and
 *   each after a host reconnect (`BackendRegistry.setHostServerSync`);
 * - the manifest when a project on that host changes or that host's cached
 *   PR data does, debounced (~1 s), and only if it actually differs from
 *   what was last sent: `projects.json` is written for many reasons (a hook
 *   cursor, a selection), and none of them is news to the box;
 * - the layout on the `LayoutStore`'s own save debounce, for each host
 *   whose part of the layout differs from what it was last sent.
 */

import type { PersistedProject, WorkspaceInfo } from "../projects/types";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import type { PrInfo } from "../../src/lib/pr-info";
import { LOCAL_HOST_ID } from "./types";
import { parseWorkspaceKey } from "../../src/lib/workspace-key";
import { errorMessage } from "../lib/errors";
import {
  HOST_LAYOUT_VERSION,
  type HostLayoutSnapshot,
} from "../host-server/layout";
import {
  HOST_MANIFEST_VERSION,
  type HostManifest,
  type IssueSnapshot,
  type ManifestProject,
  type PrSnapshot,
  type WorkspaceIntegrationSnapshot,
} from "../host-server/manifest";
import type { VapidKeys } from "../remote-control/push";
import type { HostServerClient } from "./host-server-client";

/** What the manifest is built from: the desktop's memory, never the network. */
export interface ManifestSources {
  /** `ProjectManager.manifestRecords`: the host's projects, groups resolved. */
  projects(hostId: string): PersistedProject[];
  /** `ProjectManager.knownWorkspaces`: a project's last worktree listing. */
  workspaces(projectId: string): Pick<WorkspaceInfo, "path" | "branch">[];
  /** The user's name for the host (its ssh target); absent if it has none. */
  hostName?(hostId: string): string | undefined;
  /** `GitHubManager.cachedPr`: a branch's last-seen PR, and when. */
  cachedPr(
    repo: { path: string; hostId: string },
    branch: string,
  ): { pr: PrInfo | null; at: number } | undefined;
}

function prSnapshot(pr: PrInfo): PrSnapshot {
  return {
    number: pr.number,
    state: pr.state,
    title: pr.title,
    url: pr.url,
    ...(pr.isDraft !== undefined && { isDraft: pr.isDraft }),
    ...(pr.checks !== undefined && { checks: pr.checks }),
  };
}

/**
 * The manifest for `hostId` (ADR-218 D4, D8). `now` stamps `sentAt`, and
 * `takenAt` for a workspace whose snapshot has only an issue (issues are
 * persisted, so the desktop's copy is as fresh as the manifest); a PR's
 * `takenAt` is when the desktop last fetched it.
 */
export function buildHostManifest(
  hostId: string,
  sources: ManifestSources,
  now: Date = new Date(),
): HostManifest {
  const sentAt = now.toISOString();
  const projects: ManifestProject[] = [];
  const integrationSnapshot: Record<string, WorkspaceIntegrationSnapshot> = {};

  for (const record of sources.projects(hostId)) {
    const { hostPaths: _hostPaths, ...rest } = record;
    projects.push({ ...rest, hostId: LOCAL_HOST_ID });

    const branchOf = new Map<string, string>();
    for (const ws of sources.workspaces(record.id)) branchOf.set(ws.path, ws.branch);
    const paths = new Set<string>([
      ...branchOf.keys(),
      ...Object.keys(record.workspaceIssues ?? {}),
    ]);
    for (const path of paths) {
      const linked = record.workspaceIssues?.[path]?.[0];
      const issue: IssueSnapshot | null = linked
        ? {
            id: linked.id,
            title: linked.title,
            url: linked.url,
            ...(linked.identifier !== undefined && { identifier: linked.identifier }),
          }
        : null;
      const branch = branchOf.get(path);
      // Keyed by the branch as the renderer's PR watcher asked for it, which
      // is the branch this same listing gave it.
      const seen =
        branch !== undefined
          ? sources.cachedPr({ path: record.path, hostId }, branch)
          : undefined;
      const pr = seen?.pr ? prSnapshot(seen.pr) : null;
      if (!issue && !pr) continue;
      integrationSnapshot[path] = {
        takenAt: pr && seen ? new Date(seen.at).toISOString() : sentAt,
        issue,
        pr,
      };
    }
  }

  const hostName = sources.hostName?.(hostId);
  return {
    version: HOST_MANIFEST_VERSION,
    sentAt,
    ...(hostName && { hostName }),
    projects,
    integrationSnapshot,
  };
}

/** A manifest without its timestamps, to tell a real change from a re-stamp. */
function manifestFingerprint(manifest: HostManifest): string {
  const snapshot: Record<string, Omit<WorkspaceIntegrationSnapshot, "takenAt">> = {};
  for (const [path, entry] of Object.entries(manifest.integrationSnapshot)) {
    snapshot[path] = { issue: entry.issue, pr: entry.pr };
  }
  return JSON.stringify([manifest.projects, snapshot, manifest.hostName ?? null]);
}

function layoutFingerprint(snapshot: HostLayoutSnapshot): string {
  return JSON.stringify([snapshot.workspaces, snapshot.lastActiveWorkspacePath]);
}

/** The registry's side of the push: each remote host's owner channel. */
export interface HostServerRegistry {
  hostServer(hostId: string): HostServerClient | undefined;
  hostServers(): HostServerClient[];
  setHostServerSync(sync: (hostId: string, client: HostServerClient) => Promise<void>): void;
}

export interface HostServerSyncOptions {
  registry: HostServerRegistry;
  /** The manifest for a host, now (`buildHostManifest`). */
  manifest(hostId: string): HostManifest;
  /** The layout for a host, now (`hostLayoutSnapshot` over the store). */
  layout(hostId: string): HostLayoutSnapshot;
  /**
   * The desktop's VAPID pair, sent so the host server signs pushes with it
   * (D3). Null when it cannot be stored safely; nothing is sent then.
   */
  vapidKeys?(): Promise<VapidKeys | null>;
  /**
   * The host's server changed its key and so cleared its subscriptions:
   * whatever the desktop cached about its push endpoints is stale (a stale
   * skip would drop the push, not duplicate it).
   */
  onVapidKeysChanged?(hostId: string): void;
  /** Manifest debounce. Defaults to 1 s. */
  debounceMs?: number;
  log?: Pick<Console, "warn">;
}

export class HostServerSync {
  private readonly registry: HostServerRegistry;
  private readonly buildManifest: (hostId: string) => HostManifest;
  private readonly buildLayout: (hostId: string) => HostLayoutSnapshot;
  private readonly onVapidKeysChanged: ((hostId: string) => void) | undefined;
  private readonly vapidKeys: (() => Promise<VapidKeys | null>) | undefined;
  private readonly debounceMs: number;
  private readonly log: Pick<Console, "warn">;
  /** What each host's server was last sent, without timestamps. */
  private readonly sentManifest = new Map<string, string>();
  private readonly sentLayout = new Map<string, string>();
  private readonly manifestTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: HostServerSyncOptions) {
    this.registry = opts.registry;
    this.buildManifest = opts.manifest;
    this.buildLayout = opts.layout;
    this.vapidKeys = opts.vapidKeys;
    this.onVapidKeysChanged = opts.onVapidKeysChanged;
    this.debounceMs = opts.debounceMs ?? 1_000;
    this.log = opts.log ?? console;
  }

  /** Re-send both, whole, after every connect of a host's owner channel. */
  start(): void {
    this.registry.setHostServerSync((hostId, client) => this.sendAll(hostId, client));
  }

  /**
   * Something the manifest is built from changed — a project, a PR — for
   * `hostId`, or for every host when none is named. Debounced per host.
   */
  manifestChanged(hostId?: string): void {
    const ids = hostId
      ? [hostId]
      : this.registry.hostServers().map((client) => client.hostId);
    for (const id of ids) {
      if (id === LOCAL_HOST_ID || this.manifestTimers.has(id)) continue;
      const timer = setTimeout(() => {
        this.manifestTimers.delete(id);
        void this.pushManifest(id);
      }, this.debounceMs);
      timer.unref?.();
      this.manifestTimers.set(id, timer);
    }
  }

  /**
   * The layout store saved: send each connected host whose part of the
   * layout differs from what it was last sent.
   */
  layoutPersisted(): void {
    for (const client of this.registry.hostServers()) {
      if (client.state !== "connected") continue;
      void this.pushLayout(client.hostId, client, false);
    }
  }

  dispose(): void {
    for (const timer of this.manifestTimers.values()) clearTimeout(timer);
    this.manifestTimers.clear();
  }

  private async sendAll(hostId: string, client: HostServerClient): Promise<void> {
    // A new connection may be a new server that has nothing: send whole.
    this.sentManifest.delete(hostId);
    this.sentLayout.delete(hostId);
    await Promise.all([
      this.pushManifest(hostId, client),
      this.pushLayout(hostId, client, true),
      this.pushVapidKeys(hostId, client),
    ]);
  }

  /** Whole, every connect: idempotent on the server unless the key changed. */
  private async pushVapidKeys(hostId: string, client: HostServerClient): Promise<void> {
    if (!this.vapidKeys) return;
    try {
      const keys = await this.vapidKeys();
      if (keys && (await client.setVapidKeys(keys))) this.onVapidKeysChanged?.(hostId);
    } catch (err) {
      this.log.warn(`[host-server-sync] ${hostId}: setVapidKeys failed: ${errorMessage(err)}`);
    }
  }

  private async pushManifest(
    hostId: string,
    client = this.registry.hostServer(hostId),
  ): Promise<void> {
    if (!client || client.state !== "connected") return;
    let manifest: HostManifest;
    try {
      manifest = this.buildManifest(hostId);
    } catch (err) {
      this.log.warn(`[host-server-sync] building ${hostId}'s manifest failed: ${errorMessage(err)}`);
      return;
    }
    const fingerprint = manifestFingerprint(manifest);
    if (this.sentManifest.get(hostId) === fingerprint) return;
    this.sentManifest.set(hostId, fingerprint);
    try {
      await client.syncManifest(manifest);
    } catch (err) {
      // Sent again on the next change or connect.
      if (this.sentManifest.get(hostId) === fingerprint) this.sentManifest.delete(hostId);
      this.log.warn(`[host-server-sync] ${hostId}: syncManifest failed: ${errorMessage(err)}`);
    }
  }

  private async pushLayout(
    hostId: string,
    client: HostServerClient,
    force: boolean,
  ): Promise<void> {
    let snapshot: HostLayoutSnapshot;
    try {
      snapshot = this.buildLayout(hostId);
    } catch (err) {
      this.log.warn(`[host-server-sync] building ${hostId}'s layout failed: ${errorMessage(err)}`);
      return;
    }
    const fingerprint = layoutFingerprint(snapshot);
    if (!force && this.sentLayout.get(hostId) === fingerprint) return;
    this.sentLayout.set(hostId, fingerprint);
    try {
      await client.syncLayout(snapshot);
    } catch (err) {
      if (this.sentLayout.get(hostId) === fingerprint) this.sentLayout.delete(hostId);
      this.log.warn(`[host-server-sync] ${hostId}: syncLayout failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * The layout snapshot for `hostId` (ADR-218 D5): the entries of the desktop's
 * layout (`LayoutStore.getAll()`, keyed `<hostId>:<path>` for a remote
 * workspace) that belong to `hostId`, rekeyed to their bare path, with no
 * window claims (a claim is a desktop window's, and means nothing on the
 * box). `lastActiveWorkspacePath` survives only when it is on this host. The
 * box's reader (`host-server/owner.ts` `assertHostLayoutSnapshot`) must
 * accept what this builds.
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
