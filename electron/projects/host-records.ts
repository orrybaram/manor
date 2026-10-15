/**
 * The registered remote hosts in `projects.json`: how each is reached, and
 * whether it has adopted its records (ADR-183 split this out of
 * `ProjectManager`).
 */

import { hostSpecLabel } from "../backend/providers/recipes";
import { isHostSpec, LOCAL_HOST_ID, type HostSpec } from "../backend/types";
import type { StateStore } from "./state-store";

export class HostRecords {
  constructor(private readonly store: StateStore) {}

  /**
   * Registered remote hosts, in the order they were added. A host whose spec
   * this build doesn't know (a kind from a newer Manor, a hand-edited file)
   * is left out rather than registered wrong; it stays in the file.
   */
  list(): Array<{ hostId: string; spec: HostSpec }> {
    return Object.entries(this.store.state.hosts ?? {}).flatMap(([hostId, host]) =>
      isHostSpec(host.spec) ? [{ hostId, spec: host.spec }] : [],
    );
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

  /**
   * Forget `hostId`'s record — how it is reached, its adoption marks, its
   * switches (ADR-229 D8). Not saved: the caller drops what else names the
   * host in the same write.
   */
  remove(hostId: string): void {
    const hosts = this.store.state.hosts;
    if (!hosts?.[hostId]) return;
    delete hosts[hostId];
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

  /**
   * How `hostId` is named in messages: its ssh target, a recipe host's
   * recipe name (ADR-229 D2), or "this Mac".
   */
  label(hostId: string): string {
    if (hostId === LOCAL_HOST_ID) return "this Mac";
    const spec = this.store.state.hosts?.[hostId]?.spec;
    return isHostSpec(spec) ? hostSpecLabel(spec) : hostId;
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

  /** "Phones paired with this Mac can reach <host>" (ADR-228 D9); on by default. */
  linkPhones(hostId: string): boolean {
    return this.store.state.hosts?.[hostId]?.linkPhones !== false;
  }

  setLinkPhones(hostId: string, on: boolean): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || this.linkPhones(hostId) === on) return;
    if (on) delete host.linkPhones;
    else host.linkPhones = false;
    this.store.save();
  }

  /** "Keep Manor running when <host> restarts" (ADR-229 D4); absent is off. */
  supervise(hostId: string): boolean {
    return this.store.state.hosts?.[hostId]?.supervise === true;
  }

  setSupervise(hostId: string, on: boolean): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || host.supervise === on) return;
    host.supervise = on;
    this.store.save();
  }

  /** The host's linked pairings still to revoke (ADR-228 D9). */
  pendingRevokes(hostId: string): string[] {
    return [...(this.store.state.hosts?.[hostId]?.pendingRevokes ?? [])];
  }

  /** Owe `hostId` a revoke of each of `hostDeviceIds`. */
  addPendingRevokes(hostId: string, hostDeviceIds: readonly string[]): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || hostDeviceIds.length === 0) return;
    host.pendingRevokes = [...new Set([...(host.pendingRevokes ?? []), ...hostDeviceIds])];
    this.store.save();
  }

  /** `hostDeviceIds` were revoked on `hostId`: no longer owed. */
  clearPendingRevokes(hostId: string, hostDeviceIds: readonly string[]): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host?.pendingRevokes || hostDeviceIds.length === 0) return;
    const done = new Set(hostDeviceIds);
    const left = host.pendingRevokes.filter((id) => !done.has(id));
    if (left.length === host.pendingRevokes.length) return;
    if (left.length > 0) host.pendingRevokes = left;
    else delete host.pendingRevokes;
    this.store.save();
  }

  /** Mints started on the host whose answer was not handled yet (ADR-230 D11). */
  pendingMints(hostId: string): Array<{ label: string; startedAt: number }> {
    return [...(this.store.state.hosts?.[hostId]?.pendingMints ?? [])];
  }

  addPendingMint(hostId: string, mint: { label: string; startedAt: number }): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host) return;
    host.pendingMints = [
      ...(host.pendingMints ?? []).filter((m) => m.label !== mint.label),
      { label: mint.label, startedAt: mint.startedAt },
    ];
    this.store.save();
  }

  clearPendingMints(hostId: string, labels: readonly string[]): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host?.pendingMints || labels.length === 0) return;
    const done = new Set(labels);
    const left = host.pendingMints.filter((m) => !done.has(m.label));
    if (left.length === host.pendingMints.length) return;
    if (left.length > 0) host.pendingMints = left;
    else delete host.pendingMints;
    this.store.save();
  }

  /** The host's pairing keys were reset: no revoke or mint there is owed. */
  forgetOwed(hostId: string): void {
    const host = this.store.state.hosts?.[hostId];
    if (!host || (!host.pendingRevokes && !host.pendingMints)) return;
    delete host.pendingRevokes;
    delete host.pendingMints;
    this.store.save();
  }
}
