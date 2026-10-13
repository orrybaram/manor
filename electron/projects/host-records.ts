/**
 * The registered remote hosts in `projects.json`: how each is reached, and
 * whether it has adopted its records (ADR-183 split this out of
 * `ProjectManager`).
 */

import { LOCAL_HOST_ID, type HostSpec } from "../backend/types";
import type { StateStore } from "./state-store";

export class HostRecords {
  constructor(private readonly store: StateStore) {}

  /** Registered remote hosts, in the order they were added. */
  list(): Array<{ hostId: string; spec: HostSpec }> {
    return Object.entries(this.store.state.hosts ?? {}).map(([hostId, host]) => ({
      hostId,
      spec: host.spec,
    }));
  }

  /** Add a remote host, or replace how an existing one is reached. */
  save(hostId: string, spec: HostSpec): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error(`"${LOCAL_HOST_ID}" is reserved for this machine`);
    }
    const state = this.store.state;
    if (!state.hosts) state.hosts = {};
    state.hosts[hostId] = { ...state.hosts[hostId], spec };
    this.store.save();
  }

  /** Throws unless `hostId` is this machine or a registered host. */
  assertKnown(hostId: string): void {
    if (hostId === LOCAL_HOST_ID) return;
    if (!this.store.state.hosts?.[hostId]) {
      throw new Error(`Unknown host "${hostId}".`);
    }
  }

  /** Throws unless `hostId` is a registered remote host (ADR-183). */
  assertRemote(hostId: string): void {
    if (hostId === LOCAL_HOST_ID) {
      throw new Error("A remote host is required.");
    }
    this.assertKnown(hostId);
  }

  /** How `hostId` is named in messages: its ssh target, or "this Mac". */
  label(hostId: string): string {
    if (hostId === LOCAL_HOST_ID) return "this Mac";
    return this.store.state.hosts?.[hostId]?.spec.target ?? hostId;
  }

  /**
   * Whether this desktop has handed `hostId`'s records over to its host
   * server (ADR-227 D3).
   */
  isAdopted(hostId: string): boolean {
    return this.store.state.hosts?.[hostId]?.adopted === true;
  }

  /**
   * Remember that `projectIds` now live on `hostId`'s server, without
   * saving: the caller removes them in the same write, so a group's
   * `memberIds` keep them on the next load (`normalizeGroups`).
   */
  recordAdoptedProjects(hostId: string, projectIds: readonly string[]): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || projectIds.length === 0) return;
    host.adoptedProjectIds = [...new Set([...(host.adoptedProjectIds ?? []), ...projectIds])];
  }

  /** Mark `hostId` adopted (ADR-227 D3): the last step of the hand-over. */
  markAdopted(hostId: string): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || host.adopted) return;
    host.adopted = true;
    this.store.save();
  }
}
