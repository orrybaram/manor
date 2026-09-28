import type { WorkspaceMeta } from "./ipc/types";
import type { GhRepo } from "../src/lib/gh-repo";

export function assertString(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${name}: expected string, got ${typeof value}`);
  }
}

export function assertBoolean(
  value: unknown,
  name: string,
): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name}: expected boolean, got ${typeof value}`);
  }
}

export function assertNumber(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name}: expected finite number, got ${typeof value}`);
  }
}

export function assertPositiveInt(
  value: unknown,
  name: string,
): asserts value is number {
  assertNumber(value, name);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name}: expected positive integer, got ${value}`);
  }
}

export function assertStringArray(
  value: unknown,
  name: string,
): asserts value is string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name}: expected array, got ${typeof value}`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") {
      throw new Error(`${name}[${i}]: expected string, got ${typeof value[i]}`);
    }
  }
}

/**
 * An array of `{ path, hostId }` entries (ADR-183), each also carrying
 * string `extraKeys` when given.
 */
export function assertHostPaths<K extends string = never>(
  value: unknown,
  name: string,
  extraKeys: readonly K[] = [],
): asserts value is Array<{ path: string; hostId: string } & Record<K, string>> {
  if (!Array.isArray(value)) {
    throw new Error(`${name}: expected array, got ${typeof value}`);
  }
  for (let i = 0; i < value.length; i++) {
    const entry: unknown = value[i];
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${name}[${i}]: expected object, got ${typeof entry}`);
    }
    for (const key of ["path", "hostId", ...extraKeys]) {
      const field = (entry as Record<string, unknown>)[key];
      if (typeof field !== "string") {
        throw new Error(`${name}[${i}].${key}: expected string, got ${typeof field}`);
      }
    }
  }
}

/** A checkout for `gh`: `{ path, hostId }` (ADR-191). */
export function assertGhRepo(value: unknown, name: string): asserts value is GhRepo {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${name}: expected object, got ${typeof value}`);
  }
  const repo = value as Record<string, unknown>;
  assertString(repo.path, `${name}.path`);
  assertString(repo.hostId, `${name}.hostId`);
}

/** The workspaces `ports:updateWorkspaceMetadata` describes (ADR-191). */
export function assertWorkspaceMeta(
  value: unknown,
  name: string,
): asserts value is WorkspaceMeta[] {
  assertHostPaths(value, name);
  value.forEach((entry, i) => {
    const e = entry as Record<string, unknown>;
    for (const key of ["projectName", "branch"]) {
      if (e[key] !== null && typeof e[key] !== "string") {
        throw new Error(`${name}[${i}].${key}: expected string or null, got ${typeof e[key]}`);
      }
    }
    assertBoolean(e.isMain, `${name}[${i}].isMain`);
    assertBoolean(e.portlessEnabled, `${name}[${i}].portlessEnabled`);
  });
}
