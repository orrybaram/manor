/**
 * Remote hosts (ADR-160 ticket 11): listing every host and its connection
 * status, adding one, retrying a stuck connection, and checking one's tools
 * against a project (moved from `ipc/projects.ts` on main, ADR-183).
 *
 * One namespace table (ADR-182 D3), so a renderer window and a paired
 * `full` device reach the same code. Thin by
 * design: every decision about what a host's state means, and what adding one
 * does, lives in `BackendRegistry` and `ProjectManager`. This only validates
 * the boundary and wires the two together.
 */

import crypto from "node:crypto";
import { assertString } from "../../ipc-validate";
import { assertValidTarget } from "../../terminal-host/ssh-config";
import type { HostStatusInfo } from "../../backend/registry";
import {
  runHealthChecks,
  type HealthCheckResult,
} from "../../backend/health-check";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import type { HostDeps } from "../../ipc/types";
import { method, type HandlerCtx } from "../method";

export function hostsList(ctx: HandlerCtx): HostStatusInfo[] {
  return ctx.deps.backendRegistry.list();
}

export function hostsAdd(
  ctx: HandlerCtx,
  target: string,
): { hostId: string; spec: { kind: "ssh"; target: string } } {
  const { deps } = ctx;
  assertString(target, "hosts:add.target");
  const trimmed = target.trim();
  if (trimmed === "") {
    throw new Error("An ssh target is required.");
  }
  assertValidTarget(trimmed);
  const hostId = crypto.randomUUID();
  const spec = { kind: "ssh" as const, target: trimmed };
  deps.projectManager.saveHost(hostId, spec);
  deps.backendRegistry.register(hostId, spec);
  deps.backendRegistry.connectInBackground(hostId);
  return { hostId, spec };
}

export function hostsRetryConnect(ctx: HandlerCtx, hostId: string): void {
  assertString(hostId, "hosts:retryConnect.hostId");
  ctx.deps.backendRegistry.retryNow(hostId);
}

/** The ADR-178 (main) §4 checks, run through the host itself. */
export async function hostsHealthCheck(
  ctx: HandlerCtx,
  hostId: string,
  projectPath: string,
): Promise<HealthCheckResult[]> {
  const { deps } = ctx;
  assertString(hostId, "hosts:healthCheck.hostId");
  assertString(projectPath, "hosts:healthCheck.projectPath");
  deps.projectManager.assertKnownHost(hostId);
  const { shell, git } = deps.backendRegistry.get(hostId);
  return runHealthChecks(shell, git, projectPath);
}

/**
 * Wire the two host broadcasts, once, at boot (`app-lifecycle.ts`).
 *
 * `hosts.statusChanged` carries the full host list whenever any host's status
 * changes, so the settings panel and the status-bar indicator can never
 * disagree about a host's state. `hosts.reconnected` says a remote host came
 * back from a drop and its hooks replayed: every renderer reattaches its
 * panes there and recovers the ones whose sessions are gone (ADR-178 §6 on
 * main) — each acting only on the panes it has, a browser as much as a
 * window (ADR-180 D5).
 */
export function wireHostBroadcasts(
  deps: Pick<HostDeps, "backendRegistry">,
): void {
  deps.backendRegistry.onStatusChange((hosts: HostStatusInfo[]) => {
    publishRendererBroadcast("hosts", "statusChanged", hosts);
  });
  deps.backendRegistry.onHostResumed((hostId, sessionIds) => {
    publishRendererBroadcast("hosts", "reconnected", { hostId, sessionIds });
  });
}

/**
 * The host list and its connection statuses, and the health check, are reads.
 * `add` registers an ssh target and connects to it with this machine's ssh
 * config and keys; `retryConnect` kicks a stuck connection. Neither is
 * `localOnly`: a `full` device already reaches this machine's shell through
 * `pty.*` (ADR-178 D3), so pointing ssh somewhere is not a new grant — but
 * both change what every viewer's host list shows, so both are `mutating`.
 */
export const hosts = {
  list: method(hostsList),
  add: method(hostsAdd, { mutating: true }),
  retryConnect: method(hostsRetryConnect, { mutating: true }),
  healthCheck: method(hostsHealthCheck),
};
