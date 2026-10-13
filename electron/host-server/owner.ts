/**
 * What the owner hands a host server (ADR-225 D4, ADR-227 D3), checked at
 * the boundary.
 *
 * The payloads arrive as JSON over the owner channel. The owner is trusted
 * (ssh authenticated it), but a malformed payload written into this server's
 * stores would break every later read for every phone, so the shapes are
 * checked by the host table's handlers before anything is written. A bad one
 * is refused whole.
 *
 * - **The desktop's VAPID pair** (`hostServer.setVapidKeys`, ADR-225 D3).
 * - **Adoption's records** (`hostServer.adopt`, ticket 6): this host's
 *   projects (`ManifestProject`) and its part of the layout, rekeyed to bare
 *   paths. The project and layout-entry checks below are what its bundle
 *   check is built from.
 *
 * Electron-free.
 */

import {
  assertBoolean,
  assertNumber,
  assertString,
  assertStringArray,
} from "../ipc-validate";
import { LOCAL_HOST_ID } from "../../src/lib/workspace-key";
import type { LayoutEntry } from "../../src/lib/layout/protocol";
import type { ManifestProject } from "./manifest";

/** A generous ceiling: a record past this is a bug, not a big user. */
const MAX_WORKSPACES = 10_000;

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name}: expected an object`);
  }
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

/**
 * Throws unless `value` is a project this server can own: absolute path,
 * `hostId` rewritten to `local` (to the host server its own host is local),
 * and workspace records of the shapes `ProjectManager` reads.
 */
export function assertManifestProject(
  value: unknown,
  name: string,
): asserts value is ManifestProject {
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
  assertOptionalRecordOf(value.workspaceHidden, `${name}.workspaceHidden`, assertBoolean);
  assertOptionalRecordOf(value.workspaceFolderIds, `${name}.workspaceFolderIds`, assertString);
  if (value.workspaceOrder !== undefined) {
    assertStringArray(value.workspaceOrder, `${name}.workspaceOrder`);
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

/**
 * Throws unless `value` maps bare absolute workspace paths to layout
 * entries — never a host-qualified key: a phone asking for `/a/b` must find
 * it at `/a/b`.
 */
export function assertBareLayoutEntries(
  value: unknown,
  name: string,
): asserts value is Record<string, LayoutEntry> {
  assertRecord(value, name);
  const keys = Object.keys(value);
  if (keys.length > MAX_WORKSPACES) throw new Error(`${name}: too many entries`);
  for (const key of keys) {
    assertAbsolutePath(key, `${name} key`);
    const n = `${name}[${JSON.stringify(key)}]`;
    const entry = value[key];
    assertRecord(entry, n);
    assertNumber(entry.version, `${n}.version`);
    assertRecord(entry.layout, `${n}.layout`);
    assertRecord(entry.paneSessions, `${n}.paneSessions`);
    if (!Array.isArray(entry.claims)) throw new Error(`${n}.claims: expected an array`);
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
