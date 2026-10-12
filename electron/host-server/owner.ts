/**
 * What the owner tells a host server (ADR-218 D4, D5): the manifest of this
 * host's projects and the layout snapshot of its workspaces, pushed by the
 * desktop over the owner channel (`hostServer.syncManifest`,
 * `hostServer.syncLayout`) on every connect and on every change.
 *
 * Three things live here, all Electron-free:
 *
 * - **Validation at the boundary.** The payloads arrive as JSON from the
 *   owner. The owner is trusted (ssh authenticated it), but a malformed
 *   payload written to disk would break every later read for every phone,
 *   so the shapes the readers rely on (`./manifest.ts`, `./layout.ts`) are
 *   checked before anything is written. A bad one is refused whole.
 * - **Persisting** — atomically (temp file + rename), so a phone that reads
 *   while the owner writes sees the old file or the new one, never half.
 * - **Telling the phones**: `projects.changed` after a manifest, and one
 *   `layout.changed` per workspace whose layout the snapshot changed (or
 *   `removed` for one it no longer has), so a phone updates live.
 *
 * `hostLayoutSnapshot` is the desktop's half of D5 — the layout v3 entries
 * filtered to one host's `<hostId>:<path>` keys and rekeyed to bare paths —
 * kept here, beside the reader it must agree with.
 */

import fs from "node:fs";
import path from "node:path";
import type { EventArgs, EventNs, EventOf } from "../bridge/events";
import { assertNumber, assertString } from "../ipc-validate";
import type { HostServerPaths } from "../paths";
import {
  parseWorkspaceKey,
  LOCAL_HOST_ID,
} from "../../src/lib/workspace-key";
import type {
  LayoutBroadcast,
  LayoutEntry,
} from "../../src/lib/layout/protocol";
import {
  HOST_LAYOUT_VERSION,
  readLayoutSnapshot,
  type HostLayoutSnapshot,
} from "./layout";
import type { PaneContext } from "../agent-status/effects";
import {
  HOST_MANIFEST_VERSION,
  type HostManifest,
  type ManifestProject,
} from "./manifest";

/** Generous ceilings: a manifest past these is a bug, not a big user. */
const MAX_PROJECTS = 1_000;
const MAX_WORKSPACES = 10_000;

// ── validation ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name}: expected an object`);
}

function assertAbsolutePath(value: unknown, name: string): asserts value is string {
  assertString(value, name);
  if (!value.startsWith("/")) {
    throw new Error(`${name}: expected an absolute path, got ${JSON.stringify(value)}`);
  }
}

/** `value` is absent, or a string or null. */
function assertOptionalNullableString(value: unknown, name: string): void {
  if (value === undefined || value === null) return;
  assertString(value, name);
}

/** `value` is absent, or an object whose every value passes `check`. */
function assertOptionalRecordOf(
  value: unknown,
  name: string,
  check: (entry: unknown, entryName: string) => void,
): void {
  if (value === undefined) return;
  assertRecord(value, name);
  const keys = Object.keys(value);
  if (keys.length > MAX_WORKSPACES) throw new Error(`${name}: too many entries`);
  for (const key of keys) check(value[key], `${name}[${JSON.stringify(key)}]`);
}

function assertIssueLike(value: unknown, name: string): void {
  assertRecord(value, name);
  assertString(value.id, `${name}.id`);
  assertString(value.title, `${name}.title`);
  assertString(value.url, `${name}.url`);
  if (value.identifier !== undefined) {
    assertString(value.identifier, `${name}.identifier`);
  }
}

function assertManifestProject(value: unknown, name: string): void {
  assertRecord(value, name);
  assertString(value.id, `${name}.id`);
  assertString(value.name, `${name}.name`);
  assertAbsolutePath(value.path, `${name}.path`);
  if (value.hostId !== LOCAL_HOST_ID) {
    // To the host server its own host is local: the desktop rewrites it.
    throw new Error(`${name}.hostId: expected "${LOCAL_HOST_ID}"`);
  }
  assertString(value.defaultBranch, `${name}.defaultBranch`);
  assertNumber(value.selectedWorkspaceIndex, `${name}.selectedWorkspaceIndex`);
  if (!Array.isArray(value.workspaces)) {
    throw new Error(`${name}.workspaces: expected an array`);
  }
  assertOptionalNullableString(value.defaultRunCommand, `${name}.defaultRunCommand`);
  assertOptionalNullableString(value.worktreePath, `${name}.worktreePath`);
  assertOptionalNullableString(value.color, `${name}.color`);
  assertOptionalNullableString(value.agentCommand, `${name}.agentCommand`);
  assertOptionalNullableString(value.themeName, `${name}.themeName`);
  assertOptionalRecordOf(value.workspaceNames, `${name}.workspaceNames`, assertString);
  assertOptionalRecordOf(value.workspaceIssues, `${name}.workspaceIssues`, (issues, n) => {
    if (!Array.isArray(issues)) throw new Error(`${n}: expected an array`);
    issues.forEach((issue, i) => assertIssueLike(issue, `${n}[${i}]`));
  });
  assertOptionalRecordOf(value.workspaceHidden, `${name}.workspaceHidden`, (v, n) => {
    if (typeof v !== "boolean") throw new Error(`${n}: expected boolean`);
  });
  assertOptionalRecordOf(value.workspaceFolderIds, `${name}.workspaceFolderIds`, assertString);
  if (value.workspaceOrder !== undefined) {
    if (
      !Array.isArray(value.workspaceOrder) ||
      !value.workspaceOrder.every((p) => typeof p === "string")
    ) {
      throw new Error(`${name}.workspaceOrder: expected an array of strings`);
    }
  }
  if (value.workspaceFolders !== undefined) {
    if (!Array.isArray(value.workspaceFolders)) {
      throw new Error(`${name}.workspaceFolders: expected an array`);
    }
    value.workspaceFolders.forEach((folder, i) => {
      const n = `${name}.workspaceFolders[${i}]`;
      assertRecord(folder, n);
      assertString(folder.id, `${n}.id`);
      assertString(folder.name, `${n}.name`);
      assertOptionalNullableString(folder.parentId, `${n}.parentId`);
    });
  }
}

function assertIntegrationSnapshot(value: unknown, name: string): void {
  assertRecord(value, name);
  assertString(value.takenAt, `${name}.takenAt`);
  if (value.issue !== null) assertIssueLike(value.issue, `${name}.issue`);
  if (value.pr !== null) {
    const n = `${name}.pr`;
    assertRecord(value.pr, n);
    assertNumber(value.pr.number, `${n}.number`);
    assertString(value.pr.state, `${n}.state`);
    assertString(value.pr.title, `${n}.title`);
    assertString(value.pr.url, `${n}.url`);
    if (value.pr.checks !== undefined && value.pr.checks !== null) {
      assertRecord(value.pr.checks, `${n}.checks`);
    }
  }
}

/** Throws unless `value` is a VAPID key pair (`hostServer.setVapidKeys`). */
export function assertVapidKeys(
  value: unknown,
): asserts value is { publicKey: string; privateKey: string } {
  assertRecord(value, "vapidKeys");
  assertString(value.publicKey, "vapidKeys.publicKey");
  assertString(value.privateKey, "vapidKeys.privateKey");
  if (value.publicKey === "" || value.privateKey === "") {
    throw new Error("vapidKeys: keys must not be empty");
  }
}

/** Throws unless `value` is a manifest `./manifest.ts` can serve. */
export function assertHostManifest(value: unknown): asserts value is HostManifest {
  assertRecord(value, "manifest");
  if (value.version !== HOST_MANIFEST_VERSION) {
    throw new Error(
      `manifest.version: expected ${HOST_MANIFEST_VERSION}, got ${JSON.stringify(value.version)}`,
    );
  }
  assertString(value.sentAt, "manifest.sentAt");
  if (value.hostName !== undefined) {
    assertString(value.hostName, "manifest.hostName");
  }
  if (!Array.isArray(value.projects)) {
    throw new Error("manifest.projects: expected an array");
  }
  if (value.projects.length > MAX_PROJECTS) {
    throw new Error("manifest.projects: too many projects");
  }
  value.projects.forEach((p, i) => assertManifestProject(p, `manifest.projects[${i}]`));
  const snapshot = value.integrationSnapshot;
  assertRecord(snapshot, "manifest.integrationSnapshot");
  const paths = Object.keys(snapshot);
  if (paths.length > MAX_WORKSPACES) {
    throw new Error("manifest.integrationSnapshot: too many entries");
  }
  for (const key of paths) {
    assertAbsolutePath(key, "manifest.integrationSnapshot key");
    assertIntegrationSnapshot(
      snapshot[key],
      `manifest.integrationSnapshot[${JSON.stringify(key)}]`,
    );
  }
}

function assertLayoutEntry(value: unknown, name: string): void {
  assertRecord(value, name);
  assertNumber(value.version, `${name}.version`);
  assertRecord(value.layout, `${name}.layout`);
  assertRecord(value.paneSessions, `${name}.paneSessions`);
  if (!Array.isArray(value.claims)) throw new Error(`${name}.claims: expected an array`);
}

/**
 * Throws unless `value` is a layout snapshot `./layout.ts` can serve: every
 * key a bare absolute path (the desktop strips `<hostId>:`), never a
 * host-qualified key — a phone asking for `/a/b` must find it at `/a/b`.
 */
export function assertHostLayoutSnapshot(
  value: unknown,
): asserts value is HostLayoutSnapshot {
  assertRecord(value, "layout");
  if (value.version !== HOST_LAYOUT_VERSION) {
    throw new Error(
      `layout.version: expected ${HOST_LAYOUT_VERSION}, got ${JSON.stringify(value.version)}`,
    );
  }
  assertString(value.takenAt, "layout.takenAt");
  if (value.lastActiveWorkspacePath !== null) {
    assertAbsolutePath(value.lastActiveWorkspacePath, "layout.lastActiveWorkspacePath");
  }
  assertRecord(value.workspaces, "layout.workspaces");
  const keys = Object.keys(value.workspaces);
  if (keys.length > MAX_WORKSPACES) throw new Error("layout.workspaces: too many entries");
  for (const key of keys) {
    assertAbsolutePath(key, "layout.workspaces key");
    assertLayoutEntry(value.workspaces[key], `layout.workspaces[${JSON.stringify(key)}]`);
  }
}

// ── the desktop's half: one host's part of the layout ──

/**
 * The layout snapshot for `hostId` (ADR-218 D5): the entries of the desktop's
 * layout (`LayoutStore.getAll()`, keyed `<hostId>:<path>` for a remote
 * workspace) that belong to `hostId`, rekeyed to their bare path, with no
 * window claims (a claim is a desktop window's, and means nothing on the
 * box). `lastActiveWorkspacePath` survives only when it is on this host.
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

// ── pane context, for a new agent's record ──

/** Every workspace path a manifest project's own records name. */
function knownWorkspacePaths(project: ManifestProject): Set<string> {
  const known = new Set<string>([project.path]);
  for (const record of [
    project.workspaceNames,
    project.workspaceIssues,
    project.workspaceHidden,
    project.workspaceFolderIds,
  ]) {
    for (const key of Object.keys(record ?? {})) known.add(key);
  }
  for (const key of project.workspaceOrder ?? []) known.add(key);
  return known;
}

/**
 * Which project and workspace a pane is in, from what the owner synced
 * (ADR-218 D2): the workspace whose layout holds the pane, and the manifest
 * project that names that workspace (its root, a workspace it keeps a name,
 * issue, folder or place in the order for, or one under its worktree
 * directory). Undefined when the snapshot predates the pane — the agent is
 * then recorded without a project, as on the desktop before its renderer
 * says.
 */
export function paneContextFrom(
  manifest: HostManifest,
  layout: HostLayoutSnapshot,
  paneId: string,
): PaneContext | undefined {
  const workspacePath = Object.entries(layout.workspaces).find(
    ([, entry]) => paneId in entry.paneSessions,
  )?.[0];
  if (!workspacePath) return undefined;
  const project = manifest.projects.find(
    (p) =>
      knownWorkspacePaths(p).has(workspacePath) ||
      (!!p.worktreePath &&
        p.worktreePath.startsWith("/") &&
        workspacePath.startsWith(`${p.worktreePath.replace(/\/+$/, "")}/`)),
  );
  if (!project) return undefined;
  return {
    projectId: project.id,
    projectName: project.name,
    workspacePath,
    agentCommand: project.agentCommand ?? null,
  };
}

// ── the box's half: persist and tell the phones ──

/**
 * Write `value` as JSON to `file`, mode 0600, atomically: a temp file in the
 * same directory, then a rename over the old one.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Never written.
    }
    throw err;
  }
}

/** A keyless event to this server's connections (`BridgeServerCore.broadcast`). */
export type OwnerSyncPublish = <N extends EventNs, E extends EventOf<N>>(
  ns: N,
  event: E,
  args: EventArgs<N, E>,
) => void;

export interface OwnerSync {
  /** Validate, persist and announce a manifest. */
  syncManifest(manifest: unknown): true;
  /** Validate, persist and announce a layout snapshot. */
  syncLayout(snapshot: unknown): true;
}

/** The origin a synced layout's broadcasts carry: the owner, not a viewer. */
const OWNER_ORIGIN = { kind: "route", id: "owner" } as const;

export function createOwnerSync(opts: {
  paths: Pick<HostServerPaths, "manifest" | "layout">;
  publish: OwnerSyncPublish;
}): OwnerSync {
  const { paths, publish } = opts;
  return {
    syncManifest(manifest) {
      assertHostManifest(manifest);
      writeJsonAtomic(paths.manifest, manifest);
      publish("projects", "changed", []);
      return true;
    },

    syncLayout(snapshot) {
      assertHostLayoutSnapshot(snapshot);
      const before = readLayoutSnapshot(paths.layout).workspaces;
      writeJsonAtomic(paths.layout, snapshot);
      // A phone replaces its replica of a workspace on `layout.changed`
      // (ADR-179 D1), so only the workspaces that changed are announced.
      for (const [workspacePath, entry] of Object.entries(snapshot.workspaces)) {
        const previous = before[workspacePath];
        if (previous && JSON.stringify(previous) === JSON.stringify(entry)) {
          continue;
        }
        const payload: LayoutBroadcast = {
          workspacePath,
          version: entry.version,
          layout: entry.layout,
          claims: [],
          origin: OWNER_ORIGIN,
        };
        publish("layout", "changed", [payload]);
      }
      for (const [workspacePath, entry] of Object.entries(before)) {
        if (workspacePath in snapshot.workspaces) continue;
        const payload: LayoutBroadcast = {
          workspacePath,
          version: entry.version,
          layout: entry.layout,
          claims: [],
          origin: OWNER_ORIGIN,
          removed: true,
        };
        publish("layout", "changed", [payload]);
      }
      return true;
    },
  };
}
