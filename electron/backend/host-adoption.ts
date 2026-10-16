/**
 * The desktop's half of adoption (ADR-227 D3): handing what it holds for a
 * remote host — that host's projects, agents and layout — to the host's own
 * server, then letting go of it.
 *
 * Run on every connect of a host's owner channel (`HostServerSync`):
 *
 * 1. **Read the host's `ownership`** (`hostServer.status`).
 * 2. **Send** the bundle (`hostServer.adopt`) when the host is `pending` —
 *    empty for a host this desktop holds nothing for — or when it is `host`
 *    but this desktop has not finished handing over (`PersistedHost.adopted`
 *    unset) and still holds records for it: a crash after the ack, a second
 *    laptop. The host merges by id and wins every conflict, so a resend adds
 *    what it lacks and overwrites nothing.
 * 3. **Only after the ack** (`ownership: "host"`), and only the records that
 *    were sent:
 *    1. write a backup, `~/.manor/backups/pre-adr-227-<hostId>.json`;
 *    2. remove the projects from `projects.json`, keeping their ids in
 *       groups' `memberIds`;
 *    3. remove the agents from `agents.json`;
 *    4. release the `<hostId>:*` layout entries (nothing ends: the sessions
 *       carry on, on the host);
 *    5. mark the host `adopted`.
 *
 * A crash anywhere leaves the host `pending` (nothing merged yet) or `host`
 * with the desktop not yet `adopted`; either way the next connect sends what
 * is left and finishes. Once the desktop is `adopted`, a connect to a `host`
 * is the status read, and the hand-over of any project the desktop still
 * holds for it (`handOver`). A host server that predates ownership (no
 * `ownership` in its status) is left alone.
 *
 * Once adopted, the desktop reads and writes a host's state through its
 * server (ADR-227 D4), and records no agents for it: any left from before
 * the desktop stopped replaying the host's hooks are dropped on connect.
 */

import fs from "node:fs";
import path from "node:path";
import { LOCAL_HOST_ID } from "./types";
import { agentHostId, type AgentInfo, type AgentManager, type PaneHostLookup } from "../agent-persistence";
import type { AdoptionBundle } from "../host-server/adopt";
import type { LayoutStore } from "../layout/layout-store";
import { writeFileAtomic } from "../lib/fs-atomic";
import { backupsDir } from "../paths";
import type { ProjectManager } from "../projects/project-manager";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import { parseWorkspaceKey } from "../../src/lib/workspace-key";
import type { HostServerApi } from "./host-server-client";
import { hostLayoutSnapshot } from "./host-server-sync";

/** What adoption needs of a host's owner channel. */
export interface AdoptionChannel {
  api: {
    hostServer: Pick<HostServerApi["hostServer"], "status" | "adopt">;
    /**
     * The host's projects once it has merged them: a record it matched by
     * path rather than by id lives on under the host's id, and the
     * desktop's groups follow it there. Without it, ids are not remapped.
     */
    projects?: Pick<HostServerApi["projects"], "getAll">;
  };
}

export interface HostAdoptionOptions {
  projectManager: Pick<
    ProjectManager,
    | "manifestRecords"
    | "hostProjectRecords"
    | "removeAdoptedProjects"
    | "isHostAdopted"
    | "markHostAdopted"
    | "remapProjectIds"
  >;
  agentManager: Pick<AgentManager, "getAllAgents" | "removeAgents">;
  layoutStore: Pick<
    LayoutStore,
    "whenLoaded" | "getAll" | "getLastActiveWorkspacePath" | "release"
  >;
  /** A pane's session owner: which host an agent runs on (ADR-191 §5). */
  getPaneHostId: PaneHostLookup;
  /**
   * Told after a host's projects left `projects.json`, or it was first
   * marked adopted: either way its projects now come from its server.
   */
  onProjectsRemoved?(hostId: string): void;
  /** Told once, when `hostId` is first marked adopted. */
  onAdopted?(hostId: string): void;
  /** Told after agents left `agents.json`, so a renderer drops its copies. */
  onAgentsRemoved?(agentIds: readonly string[]): void;
  /** Defaults to `backupsDir()`. */
  backupDir?: string;
  now?: () => Date;
  log?: Pick<Console, "info" | "warn">;
}

/** What one run did, for the log and for tests. */
export interface AdoptionOutcome {
  /** The host's ownership when asked; `null` for a server that has none. */
  ownership: "pending" | "host" | null;
  /** Whether a bundle was sent (and acknowledged). */
  sent: boolean;
  /** Where the removed records were copied to; null when none were removed. */
  backup: string | null;
  removed: { projects: number; agents: number; workspaces: number };
}

/** Bumped when the backup file's shape changes. */
const BACKUP_VERSION = 1;

/** What this desktop still holds for one host, as sent and as stored. */
interface LocalRecords {
  bundle: AdoptionBundle;
  projectIds: string[];
  agents: AgentInfo[];
  /** The desktop's own `<hostId>:<path>` keys, and their entries. */
  layout: Record<string, LayoutEntry>;
}

/** A host id as a file-name part. */
function fileSafe(hostId: string): string {
  return hostId.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class HostAdoption {
  private readonly opts: HostAdoptionOptions;
  private readonly log: Pick<Console, "info" | "warn">;
  /** One run per host at a time: a reconnect waits for the run before it. */
  private readonly runs = new Map<string, Promise<unknown>>();
  /** Who waits for each host's first adoption (`whenAdopted`). */
  private readonly adoptedWaiters = new Map<string, Array<() => void>>();

  constructor(opts: HostAdoptionOptions) {
    this.opts = opts;
    this.log = opts.log ?? console;
  }

  /** Adopt `hostId` onto its server, or finish an adoption left part-way. */
  run(hostId: string, channel: AdoptionChannel): Promise<AdoptionOutcome> {
    const previous = this.runs.get(hostId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.runNow(hostId, channel));
    const settled = run.catch(() => {});
    this.runs.set(hostId, settled);
    void settled.then(() => {
      if (this.runs.get(hostId) === settled) this.runs.delete(hostId);
    });
    return run;
  }

  /**
   * Resolves `true` once `hostId` is adopted — at once when it already is,
   * else when a run marks it so — or `false` when `timeoutMs` passes first:
   * a server that predates ownership, or an owner channel that never came
   * up. Never rejects; a failed run leaves it waiting for the next one.
   * `openInNewHost` (ADR-235 D3) waits on it so a new host's first project
   * is made on its server rather than handed over later.
   */
  whenAdopted(hostId: string, timeoutMs = 30_000): Promise<boolean> {
    if (this.opts.projectManager.isHostAdopted(hostId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiters = this.adoptedWaiters.get(hostId) ?? [];
      // Only ever called after `timer` below is set: a run settles later.
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      waiters.push(done);
      this.adoptedWaiters.set(hostId, waiters);
      const timer = setTimeout(() => {
        const left = (this.adoptedWaiters.get(hostId) ?? []).filter((w) => w !== done);
        if (left.length > 0) this.adoptedWaiters.set(hostId, left);
        else this.adoptedWaiters.delete(hostId);
        resolve(this.opts.projectManager.isHostAdopted(hostId));
      }, timeoutMs);
    });
  }

  /** Wake whoever waits on `whenAdopted(hostId)`. */
  private notifyAdopted(hostId: string): void {
    const waiters = this.adoptedWaiters.get(hostId);
    if (!waiters) return;
    this.adoptedWaiters.delete(hostId);
    for (const wake of waiters) wake();
  }

  /**
   * Hand `projectIds` — projects this desktop holds for `hostId` — and its
   * `<hostId>:*` layout to the host's server, adopted or not, then let go
   * of them: how a project moved onto the host gets there (ADR-227 D4).
   * The host merges them as it does any adoption. No agents go: a host
   * that has adopted holds its own. Runs after any adoption in flight for
   * the host.
   */
  handOver(
    hostId: string,
    channel: AdoptionChannel,
    projectIds: readonly string[],
  ): Promise<AdoptionOutcome> {
    const previous = this.runs.get(hostId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.handOverNow(hostId, channel, projectIds));
    const settled = run.catch(() => {});
    this.runs.set(hostId, settled);
    void settled.then(() => {
      if (this.runs.get(hostId) === settled) this.runs.delete(hostId);
    });
    return run;
  }

  private async handOverNow(
    hostId: string,
    channel: AdoptionChannel,
    projectIds: readonly string[],
  ): Promise<AdoptionOutcome> {
    const outcome: AdoptionOutcome = {
      ownership: null,
      sent: false,
      backup: null,
      removed: { projects: 0, agents: 0, workspaces: 0 },
    };
    await this.opts.layoutStore.whenLoaded();
    const wanted = new Set(projectIds);
    const local = this.localRecords(hostId);
    const projects = local.bundle.projects.filter((p) => wanted.has(p.id));
    if (projects.length === 0 && Object.keys(local.layout).length === 0) return outcome;
    const ack = await channel.api.hostServer.adopt({ ...local.bundle, projects, agents: [] });
    if (ack.ownership !== "host") {
      throw new Error(`${hostId} did not take its records (ownership ${String(ack.ownership)})`);
    }
    outcome.ownership = "host";
    outcome.sent = true;
    outcome.backup = this.writeBackup(hostId, {
      ...local,
      projectIds: projects.map((p) => p.id),
      agents: [],
    });
    const { projectManager, layoutStore } = this.opts;
    outcome.removed.projects = projectManager.removeAdoptedProjects(
      hostId,
      projects.map((p) => p.id),
    ).length;
    if (outcome.removed.projects > 0) this.opts.onProjectsRemoved?.(hostId);
    await layoutStore.release(Object.keys(local.layout));
    outcome.removed.workspaces = Object.keys(local.layout).length;
    return outcome;
  }

  private async runNow(hostId: string, channel: AdoptionChannel): Promise<AdoptionOutcome> {
    const outcome: AdoptionOutcome = {
      ownership: null,
      sent: false,
      backup: null,
      removed: { projects: 0, agents: 0, workspaces: 0 },
    };
    const status = await channel.api.hostServer.status();
    const ownership = (status as { ownership?: unknown }).ownership;
    // A server from before the flip owns nothing and has no `adopt`.
    if (ownership !== "pending" && ownership !== "host") return outcome;
    outcome.ownership = ownership;
    // Handed over already: a connect is this read, and the hand-over of any
    // project this desktop still holds for the host — one moved there while
    // it was away, or added as adoption ran. Agents it recorded for the host
    // since are only repeats of the host's own: dropped.
    if (ownership === "host" && this.opts.projectManager.isHostAdopted(hostId)) {
      this.dropRepeatedAgents(hostId);
      const held = this.opts.projectManager.manifestRecords(hostId).map((p) => p.id);
      if (held.length === 0) return outcome;
      const handed = await this.handOverNow(hostId, channel, held);
      return { ...handed, ownership };
    }

    await this.opts.layoutStore.whenLoaded();
    const local = this.localRecords(hostId);
    const holdsAny =
      local.projectIds.length > 0 ||
      local.agents.length > 0 ||
      Object.keys(local.layout).length > 0;

    if (ownership === "pending" || holdsAny) {
      const ack = await channel.api.hostServer.adopt(local.bundle);
      if (ack.ownership !== "host") {
        throw new Error(`${hostId} did not take its records (ownership ${String(ack.ownership)})`);
      }
      outcome.sent = true;
      this.log.info(
        `[host-adoption] ${hostId}: adopted ${local.projectIds.length} projects, ${local.agents.length} agents, ${Object.keys(local.layout).length} workspaces`,
      );
    }

    // Only after the ack, and only what was sent.
    if (holdsAny) {
      outcome.backup = this.writeBackup(hostId, local);
      if (outcome.sent) await this.remapMergedIds(hostId, channel, local);
      const { projectManager, agentManager, layoutStore } = this.opts;
      outcome.removed.projects = projectManager.removeAdoptedProjects(hostId, local.projectIds).length;
      const agentIds = local.agents.map((a) => a.id);
      outcome.removed.agents = agentManager.removeAgents(agentIds);
      if (agentIds.length > 0) this.opts.onAgentsRemoved?.(agentIds);
      await layoutStore.release(Object.keys(local.layout));
      outcome.removed.workspaces = Object.keys(local.layout).length;
    }
    const wasAdopted = this.opts.projectManager.isHostAdopted(hostId);
    this.opts.projectManager.markHostAdopted(hostId);
    // Only now: a renderer that reads the list on this news finds the
    // host's projects through its server, not in neither list.
    if (outcome.removed.projects > 0 || !wasAdopted) this.opts.onProjectsRemoved?.(hostId);
    if (!wasAdopted) this.opts.onAdopted?.(hostId);
    this.notifyAdopted(hostId);
    return outcome;
  }

  /** Forget the agents this desktop holds for an adopted host; the host has its own. */
  private dropRepeatedAgents(hostId: string): void {
    const { agentManager, getPaneHostId } = this.opts;
    const ids = agentManager
      .getAllAgents()
      .filter((agent) => agentHostId(agent, getPaneHostId) === hostId)
      .map((agent) => agent.id);
    if (ids.length === 0) return;
    agentManager.removeAgents(ids);
    this.opts.onAgentsRemoved?.(ids);
  }

  /**
   * A record the host already had at the same path, under another id — a
   * second laptop's, say — was merged into the host's (ADR-227 D3), so
   * that id is gone. Point this desktop's groups and order at the host's.
   */
  private async remapMergedIds(
    hostId: string,
    channel: AdoptionChannel,
    local: LocalRecords,
  ): Promise<void> {
    const getAll = channel.api.projects?.getAll;
    if (!getAll) return;
    let hostProjects: Array<{ id: string; path: string }>;
    try {
      hostProjects = await getAll();
    } catch (err) {
      this.log.warn(`[host-adoption] ${hostId}: could not read its projects back: ${String(err)}`);
      return;
    }
    const hostIds = new Set(hostProjects.map((p) => p.id));
    const byPath = new Map(hostProjects.map((p) => [p.path, p.id]));
    const remap = new Map<string, string>();
    for (const sent of local.bundle.projects) {
      if (hostIds.has(sent.id)) continue;
      const merged = byPath.get(sent.path);
      if (merged) remap.set(sent.id, merged);
    }
    if (remap.size > 0) this.opts.projectManager.remapProjectIds(hostId, remap);
  }

  /** Everything this desktop holds for `hostId`, and the bundle it makes. */
  private localRecords(hostId: string): LocalRecords {
    const { projectManager, agentManager, layoutStore, getPaneHostId } = this.opts;
    const projects = projectManager.manifestRecords(hostId);
    const agents = agentManager
      .getAllAgents()
      .filter((agent) => agentHostId(agent, getPaneHostId) === hostId);
    const all = layoutStore.getAll();
    const layout: Record<string, LayoutEntry> = {};
    for (const [key, entry] of Object.entries(all)) {
      if (parseWorkspaceKey(key).hostId === hostId) layout[key] = entry;
    }
    const now = (this.opts.now ?? (() => new Date()))();
    return {
      bundle: {
        projects,
        // To the host server its own host is local.
        agents: agents.map((agent) => ({ ...agent, hostId: LOCAL_HOST_ID })),
        layout: hostLayoutSnapshot(
          layout,
          layoutStore.getLastActiveWorkspacePath(),
          hostId,
          now.toISOString(),
        ),
      },
      projectIds: projects.map((p) => p.id),
      agents,
      layout,
    };
  }

  /**
   * Copy the records about to be removed, as this desktop stores them, to
   * `pre-adr-227-<hostId>.json` — or, when an earlier run already wrote that,
   * beside it under a timestamped name: a backup is never overwritten.
   * Throws when it cannot be written, and then nothing is removed.
   */
  private writeBackup(hostId: string, local: LocalRecords): string {
    const dir = this.opts.backupDir ?? backupsDir();
    const now = (this.opts.now ?? (() => new Date()))();
    const base = `pre-adr-227-${fileSafe(hostId)}`;
    let file = path.join(dir, `${base}.json`);
    if (fs.existsSync(file)) {
      file = path.join(dir, `${base}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    }
    const { projects, groups } = this.opts.projectManager.hostProjectRecords(hostId);
    const sent = new Set(local.projectIds);
    const backup = {
      version: BACKUP_VERSION,
      hostId,
      takenAt: now.toISOString(),
      projects: projects.filter((p) => sent.has(p.id)),
      groups,
      agents: local.agents,
      layout: {
        workspaces: local.layout,
        lastActiveWorkspacePath: this.opts.layoutStore.getLastActiveWorkspacePath(),
      },
    };
    writeFileAtomic(file, JSON.stringify(backup, null, 2), { mode: 0o600, dirMode: 0o700 });
    return file;
  }
}
