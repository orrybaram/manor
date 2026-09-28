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
/** A well-formed `{ teamId, teamName, teamKey }` Linear association. */
export function isLinearAssociation(
  value: unknown,
): value is { teamId: string; teamName: string; teamKey: string } {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.teamId === "string" &&
    typeof entry.teamName === "string" &&
    typeof entry.teamKey === "string"
  );
}

/**
 * A linked-project group's shared-settings update (ADR-192): an object
 * whose `name` is a string, `color` and `agentCommand` a string or null,
 * and `linearAssociations` null (no teams) or an array of associations.
 * Absent keys are left alone.
 */
export function assertGroupUpdates(
  value: unknown,
  name: string,
): asserts value is {
  name?: string;
  color?: string | null;
  agentCommand?: string | null;
  linearAssociations?: Array<{ teamId: string; teamName: string; teamKey: string }> | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name}: expected object, got ${value === null ? "null" : typeof value}`);
  }
  const updates = value as Record<string, unknown>;
  if (updates.name !== undefined) assertString(updates.name, `${name}.name`);
  for (const key of ["color", "agentCommand"]) {
    const field = updates[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      throw new Error(`${name}.${key}: expected string or null, got ${typeof field}`);
    }
  }
  const linear = updates.linearAssociations;
  if (linear === undefined || linear === null) return;
  if (!Array.isArray(linear)) {
    throw new Error(`${name}.linearAssociations: expected array or null, got ${typeof linear}`);
  }
  linear.forEach((entry, i) => {
    if (!isLinearAssociation(entry)) {
      throw new Error(
        `${name}.linearAssociations[${i}]: expected { teamId, teamName, teamKey } strings`,
      );
    }
  });
}

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
