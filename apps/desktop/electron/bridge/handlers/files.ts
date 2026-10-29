/**
 * A workspace's files, as the `files` namespace of the handler table: what the
 * file pane browses, opens, saves and creates.
 *
 * Each call names its workspace as `{ path, hostId }`, the way the diff and
 * branch watchers are told theirs, and runs on that host's backend from the
 * registry: a remote host's files are listed, read and written on its own
 * machine (`../../workspace-files.ts`). Nothing here touches `fs`.
 *
 * A refusal the UI shows — too large, binary, changed on disk, outside the
 * workspace — is an answer (`{ ok: false, reason }`), not a thrown error, so
 * it reads the same over IPC and the socket. A host that is away, or a
 * workspace folder that is gone, still throws.
 *
 * `watch` and `unwatch` are the caller's own: what it has open, per
 * workspace, polled by the server's `OpenFileWatcher`, which publishes
 * `files.changed` to that caller alone. A connection that closes watches
 * nothing (`createManorServer`).
 *
 * `write`, `create`, `rename` and `delete` change what every other viewer of the host sees, and
 * what its agents work on, so they are `mutating`; the reads are not.
 */

import { assertString, assertStringArray } from "../../ipc-validate";
import type { ServerDeps } from "../../ipc/types";
import type { HostPath } from "../../per-host-poller";
import {
  createWorkspaceFile,
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceFile,
  writeWorkspaceFile,
  type FileListResult,
  type FileMoveResult,
  type FileReadResult,
  type FileWriteResult,
} from "../../workspace-files";
import { method, type HandlerCtx } from "../method";

export type FilesDeps = Pick<ServerDeps, "backendRegistry">;

/** What `files.watch` and `files.unwatch` need. */
export type FileWatchDeps = Pick<ServerDeps, "openFileWatcher">;

/** A workspace as a file call names it: its path and its host. */
export function assertWorkspace(value: unknown, name: string): asserts value is HostPath {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name}: expected object, got ${value === null ? "null" : typeof value}`);
  }
  const ws = value as Record<string, unknown>;
  assertString(ws.path, `${name}.path`);
  assertString(ws.hostId, `${name}.hostId`);
  if (!ws.path.startsWith("/")) throw new Error(`${name}.path: expected an absolute path`);
}

function backendFor(ctx: HandlerCtx<FilesDeps>, workspace: HostPath) {
  return ctx.deps.backendRegistry.get(workspace.hostId);
}

export function filesList(ctx: HandlerCtx<FilesDeps>, workspace: HostPath): Promise<FileListResult> {
  assertWorkspace(workspace, "workspace");
  return listWorkspaceFiles(backendFor(ctx, workspace), workspace.path);
}

export function filesRead(
  ctx: HandlerCtx<FilesDeps>,
  workspace: HostPath,
  relPath: string,
): Promise<FileReadResult> {
  assertWorkspace(workspace, "workspace");
  assertString(relPath, "relPath");
  return readWorkspaceFile(backendFor(ctx, workspace), workspace.path, relPath);
}

export function filesWrite(
  ctx: HandlerCtx<FilesDeps>,
  workspace: HostPath,
  relPath: string,
  content: string,
  expectedHash?: string,
): Promise<FileWriteResult> {
  assertWorkspace(workspace, "workspace");
  assertString(relPath, "relPath");
  assertString(content, "content");
  if (expectedHash !== undefined && expectedHash !== null) assertString(expectedHash, "expectedHash");
  return writeWorkspaceFile(
    backendFor(ctx, workspace),
    workspace.path,
    relPath,
    content,
    expectedHash ?? undefined,
  );
}

export function filesCreate(
  ctx: HandlerCtx<FilesDeps>,
  workspace: HostPath,
  relPath: string,
): Promise<FileWriteResult> {
  assertWorkspace(workspace, "workspace");
  assertString(relPath, "relPath");
  return createWorkspaceFile(backendFor(ctx, workspace), workspace.path, relPath);
}

export function filesRename(
  ctx: HandlerCtx<FilesDeps>,
  workspace: HostPath,
  fromRelPath: string,
  toRelPath: string,
): Promise<FileMoveResult> {
  assertWorkspace(workspace, "workspace");
  assertString(fromRelPath, "fromRelPath");
  assertString(toRelPath, "toRelPath");
  return renameWorkspaceFile(backendFor(ctx, workspace), workspace.path, fromRelPath, toRelPath);
}

export function filesDelete(
  ctx: HandlerCtx<FilesDeps>,
  workspace: HostPath,
  relPath: string,
): Promise<FileMoveResult> {
  assertWorkspace(workspace, "workspace");
  assertString(relPath, "relPath");
  return deleteWorkspaceFile(backendFor(ctx, workspace), workspace.path, relPath);
}

/**
 * The caller has `relPaths` of `workspace` open: they replace what it had
 * open there, and `files.changed` comes to it when one changes on disk. An
 * empty list stops watching that workspace; its other workspaces are left
 * as they are.
 */
export function filesWatch(
  ctx: HandlerCtx<FileWatchDeps>,
  workspace: HostPath,
  relPaths: string[],
): void {
  assertWorkspace(workspace, "workspace");
  assertStringArray(relPaths, "relPaths");
  ctx.deps.openFileWatcher.watch(ctx.caller.id, workspace, relPaths);
}

/** The caller has nothing open any more; its connection closing does the same. */
export function filesUnwatch(ctx: HandlerCtx<FileWatchDeps>): void {
  ctx.deps.openFileWatcher.unwatch(ctx.caller.id);
}

// Answered by the server the caller asked (home): the workspace's host is
// reached through its backend, as the diff reads are.
export const files = {
  list: method(filesList),
  read: method(filesRead),
  write: method(filesWrite, { mutating: true }),
  create: method(filesCreate, { mutating: true }),
  rename: method(filesRename, { mutating: true }),
  delete: method(filesDelete, { mutating: true }),
  // What a viewer does to its own view: not audited.
  watch: method(filesWatch),
  unwatch: method(filesUnwatch),
};
