/**
 * The hosts a project can be set up on or moved to (ADR-213/214). DOM-free,
 * and for any project: an unlinked one gets targets too.
 */

import type { HostStatusInfo } from "../store/host-store";
import { describeHost } from "./host-status";
import { LOCAL_HOST_ID, isRemoteHost, memberHostName } from "./hosts";
import { serverHostName } from "../bridge/server-set";
import type { TransferMode } from "../electron";

/** What the targets need of a project. */
interface TransferProject {
  id: string;
  hostId: string;
  group?: { memberIds: readonly string[] } | null;
}

export interface TransferTarget {
  hostId: string;
  /**
   * "This machine", or the remote host's ssh target; on a phone, the name
   * of the machine's pairing (`serverHostName`).
   */
  label: string;
  /** Why a transfer onto this host can't run now; null when it can. */
  disabledReason: string | null;
}

/** A short tag telling two same-named hosts apart: the recipe id's tail. */
function hostSuffix(host: HostStatusInfo | undefined): string | null {
  if (host?.spec?.kind !== "recipe") return null;
  const tail = host.spec.recipeId.split("-").pop() ?? "";
  return tail.slice(0, 6) || null;
}

/**
 * Two hosts listed under one name (two pods for one repo) get a suffix so
 * they can be told apart; a unique name is left alone.
 */
export function disambiguateHostLabels<T extends { hostId: string; label: string }>(
  items: readonly T[],
  hosts: readonly HostStatusInfo[],
): T[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return items.map((item) => {
    if ((counts.get(item.label) ?? 0) < 2) return item;
    const suffix = hostSuffix(hosts.find((h) => h.hostId === item.hostId));
    return suffix ? { ...item, label: `${item.label} (${suffix})` } : item;
  });
}

/**
 * Whether `host` is another project's pod: made for a project outside
 * `own` (the project and its group). With no source project `own` is empty,
 * so any pod counts.
 */
export function isOtherProjectsPod(host: HostStatusInfo, own: ReadonlySet<string>): boolean {
  return host.forProject !== undefined && !own.has(host.forProject);
}

function ownProjectIds(project: TransferProject): Set<string> {
  return new Set([project.id, ...(project.group?.memberIds ?? [])]);
}

/** Whether `transferTargets` leaves out any host as another project's pod. */
export function hasHiddenPods(project: TransferProject, hosts: readonly HostStatusInfo[]): boolean {
  const own = ownProjectIds(project);
  return hosts.some((h) => isRemoteHost(h.hostId) && isOtherProjectsPod(h, own));
}

/**
 * "This machine" first, then every registered remote host (another project's
 * pod only with `showAllHosts`), minus `project`'s
 * own host. A host is disabled when its last connect failed (`error`; one
 * merely disconnected is not, since the transfer connects it), or when the
 * project's group already has a member there: any member for a copy, any
 * other member for a move (the project itself is on the excluded host).
 */
export function transferTargets(
  project: TransferProject,
  projects: readonly TransferProject[],
  hosts: readonly HostStatusInfo[],
  mode: TransferMode,
  options: {
    showAllHosts?: boolean;
    /** A host listed even if it is another project's pod: one already picked. */
    include?: string;
  } = {},
): TransferTarget[] {
  const own = ownProjectIds(project);
  const memberIds = new Set(project.group?.memberIds ?? []);
  const taken = new Set(
    projects
      .filter((p) => p.id !== project.id && memberIds.has(p.id))
      .map((p) => p.hostId),
  );
  const shown = hosts.filter(
    (h) =>
      isRemoteHost(h.hostId) &&
      (options.showAllHosts || h.hostId === options.include || !isOtherProjectsPod(h, own)),
  );
  const ids = [LOCAL_HOST_ID, ...shown.map((h) => h.hostId)];
  const targets = ids
    .filter((hostId) => hostId !== project.hostId)
    .map((hostId) => {
      // On a phone each machine goes by its pairing's name (ADR-228 D8).
      const label = serverHostName(hostId) ?? memberHostName(hostId, hosts);
      const host = hosts.find((h) => h.hostId === hostId);
      const display = host?.status === "error" ? describeHost(host, Date.now()) : undefined;
      let disabledReason: string | null = null;
      if (taken.has(hostId)) {
        disabledReason = `Already on ${label}`;
      } else if (display) {
        disabledReason = `${display.target} is offline (${display.status.toLowerCase()}). Reconnect it to ${mode === "copy" ? "copy" : "move"} there.`;
      }
      return { hostId, label, disabledReason };
    });
  return disambiguateHostLabels(targets, hosts);
}

/** "In a new pod" for one host profile (ADR-235 D4). */
export interface NewHostTarget {
  kind: "newHost";
  profileId: string;
  /** "In a new pod · Work cluster"; a Docker profile says "container". */
  label: string;
}

/** What the new-host targets need of a profile. */
interface TargetProfile {
  id: string;
  name: string;
  templateId: string;
}

/** "pod" for a Kubernetes profile, "container" for Docker. */
export function podNoun(templateId: string): "pod" | "container" {
  return templateId === "docker" ? "container" : "pod";
}

/** One "In a new pod · <profile>" target per profile, in the profiles' order. */
export function newHostTargets(profiles: readonly TargetProfile[]): NewHostTarget[] {
  return profiles.map((profile) => ({
    kind: "newHost",
    profileId: profile.id,
    label: `In a new ${podNoun(profile.templateId)} · ${profile.name}`,
  }));
}
