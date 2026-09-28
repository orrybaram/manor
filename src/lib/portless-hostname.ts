/**
 * The `.localhost` hostnames portless gives dev-server ports.
 *
 * Pure and dependency-free: the main process routes with these hostnames
 * (`electron/ipc/ports.ts`) and the renderer previews them in project
 * settings, so both must build them by the same rules.
 */

import { LOCAL_HOST_ID } from "./host-id";

/** A DNS label: lowercase, non-alphanumeric runs → hyphens, max 63 chars. */
function sanitizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

/** How many characters of a host id its hostname segment keeps. */
const HOST_SEGMENT_LENGTH = 8;

/**
 * Each remote host's hostname segment (ADR-191 §6): the first 8 characters
 * of its id, lowercased, or its whole sanitized id when another host's id
 * starts the same way. Derived from the id, never the host's name, which can
 * be edited and need not be unique.
 *
 * Pass every registered remote host, not only those with ports, so a host's
 * segment doesn't change as other hosts' dev servers come and go.
 */
export function hostSegments(remoteHostIds: readonly string[]): Map<string, string> {
  const prefixOf = (id: string) => sanitizeLabel(id.slice(0, HOST_SEGMENT_LENGTH));
  const counts = new Map<string, number>();
  for (const id of remoteHostIds) {
    const prefix = prefixOf(id);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const segments = new Map<string, string>();
  for (const id of remoteHostIds) {
    const prefix = prefixOf(id);
    const shared = prefix === "" || (counts.get(prefix) ?? 0) > 1;
    segments.set(id, shared ? sanitizeLabel(id) : prefix);
  }
  return segments;
}

/**
 * Which host a hostname is for. `unknown` is a remote host that is not
 * registered (any more), which has no segment to claim a hostname with.
 */
export type PortlessHost =
  | { kind: "local" }
  | { kind: "remote"; segment: string }
  | { kind: "unknown" };

/** `hostId`'s `PortlessHost`, given every registered host's `hostSegments`. */
export function portlessHostFor(
  hostId: string,
  segments: ReadonlyMap<string, string>,
): PortlessHost {
  if (hostId === LOCAL_HOST_ID) return { kind: "local" };
  const segment = segments.get(hostId);
  return segment === undefined ? { kind: "unknown" } : { kind: "remote", segment };
}

/** What a hostname is built from: a workspace and its project. */
export interface PortlessWorkspace {
  path: string;
  projectName: string | null;
  branch: string | null;
  isMain: boolean;
}

/**
 * The `.localhost` hostname for a workspace's ports.
 *
 * Base: the project name, or the workspace directory's name, as a DNS label.
 * A non-main workspace with a branch is `${branch}.${base}`, any other just
 * `${base}`. A remote host adds its segment before `.localhost`, so a local
 * and a remote main of one project don't both claim `${base}.localhost`
 * (ADR-191 §6); a local hostname is unchanged.
 */
export function portlessHostname(
  workspace: PortlessWorkspace,
  host: Exclude<PortlessHost, { kind: "unknown" }>,
): string {
  const dirName = workspace.path.split("/").filter(Boolean).pop() ?? workspace.path;
  const base = sanitizeLabel(workspace.projectName || dirName);
  const suffix = host.kind === "remote" ? `${host.segment}.localhost` : "localhost";
  if (workspace.branch && !workspace.isMain) {
    return `${sanitizeLabel(workspace.branch)}.${base}.${suffix}`;
  }
  return `${base}.${suffix}`;
}
