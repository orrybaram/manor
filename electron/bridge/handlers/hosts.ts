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
import { assertBoolean, assertString } from "../../ipc-validate";
import { assertValidTarget } from "../../terminal-host/ssh-config";
import { assertRecipeId, readRecipe } from "../../backend/providers/recipes";
import {
  createCustomRecipe,
  createRecipeFromTemplate,
  listTemplates,
  type TemplateInfo,
} from "../../backend/providers/recipe-templates";
import { forgetHostFiles } from "../../backend/host-removal";
import { LOCAL_HOST_ID } from "../../backend/types";
import type { HostStatusInfo } from "../../backend/registry";
import {
  runHealthChecks,
  type HealthCheckResult,
} from "../../backend/health-check";
import { publishRendererBroadcast } from "../../renderer-broadcast";
import {
  HostServerUnavailableError,
  type HostServerClient,
  type HostServerClientState,
} from "../../backend/host-server-client";
import type { HostServerStatus } from "../../host-server/relay";
import { serverFactsOf } from "../../backend/host-server-sync";
import { runHostSupervisor } from "../../backend/host-supervisor";
import { runHostSecrets } from "../../backend/host-secrets";
import type { SecretsFacts } from "../../host-server/secrets-command";
import type { SupervisorFacts } from "../../host-server/supervisor/types";
import type { PairResult } from "../../remote-control/relay-room";
import type { RemoteDeviceInfo } from "../../remote-control/devices";
import type { ServerDeps } from "../../ipc/types";
import { LOCAL_ROUTE, method, type HandlerCtx } from "../method";

/**
 * Every host and its connection status — with, for a remote host, its
 * server's relay room and whether it takes desktop viewer streams, from the
 * last status read (ADR-228 D2, D3; `HostServerSync`).
 */
export function hostsList(ctx: HandlerCtx<ServerDeps>): HostStatusInfo[] {
  return ctx.deps.backendRegistry.list();
}

export function hostsAdd(
  ctx: HandlerCtx<ServerDeps>,
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
  // On by default for hosts added from now on (ADR-229 D4).
  deps.projectManager.setHostSupervised(hostId, true);
  deps.backendRegistry.register(hostId, spec);
  deps.backendRegistry.connectInBackground(hostId);
  return { hostId, spec };
}

/**
 * Register a host Manor starts from recipe `recipeId` (ADR-229 D2) and
 * connect it: the connect runs the recipe's `up`, its stderr lines showing
 * as the host's progress. The recipe is read from `~/.manor/host-recipes/`
 * and nowhere else, and must be valid; a recipe already used by another
 * host is refused, since a recipe's state belongs to one host.
 */
export function hostsAddRecipeHost(
  ctx: HandlerCtx<ServerDeps>,
  recipeId: string,
): { hostId: string; spec: { kind: "recipe"; recipeId: string } } {
  const { deps } = ctx;
  assertString(recipeId, "hosts:addRecipeHost.recipeId");
  assertRecipeId(recipeId);
  const recipe = readRecipe(recipeId);
  const taken = deps.projectManager
    .getHosts()
    .find(({ spec }) => spec.kind === "recipe" && spec.recipeId === recipeId);
  if (taken) {
    throw new Error(`The recipe "${recipe.name}" already starts a host.`);
  }
  const hostId = crypto.randomUUID();
  const spec = { kind: "recipe" as const, recipeId };
  deps.projectManager.saveHost(hostId, spec);
  // A box Manor starts is Manor's to keep running (ADR-229 D4).
  deps.projectManager.setHostSupervised(hostId, true);
  deps.backendRegistry.register(hostId, spec);
  // A connect somebody means: it runs `up` even for a box asleep.
  deps.backendRegistry.ensureConnected(hostId).catch(() => {
    // Reported through the host's status.
  });
  return { hostId, spec };
}

/**
 * Write a recipe from a bundled template and the form's answers (ADR-229
 * D8), and return its id. It only writes files under `~/.manor/host-recipes/`;
 * `addRecipeHost` is what starts a host from it.
 */
export function hostsCreateRecipe(
  _ctx: HandlerCtx<ServerDeps>,
  templateId: string,
  values: Record<string, string>,
): string {
  assertString(templateId, "hosts:createRecipe.templateId");
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("hosts:createRecipe.values must be an object of strings");
  }
  for (const [key, value] of Object.entries(values)) {
    assertString(value, `hosts:createRecipe.values.${key}`);
  }
  return createRecipeFromTemplate(templateId, values);
}

/**
 * "Create recipe folder" (ADR-229 D8): write a custom recipe's skeleton —
 * `recipe.json` and an `up.sh` to finish — for a host named `name`, and
 * answer its id and the file the page reveals. Starts nothing.
 */
export function hostsCreateCustomRecipe(
  _ctx: HandlerCtx<ServerDeps>,
  name: string,
): { recipeId: string; file: string } {
  assertString(name, "hosts:createCustomRecipe.name");
  return createCustomRecipe(name);
}

/** The bundled templates' names and form fields (ADR-229 D8). */
export function hostsListTemplates(_ctx: HandlerCtx<ServerDeps>): TemplateInfo[] {
  return listTemplates();
}

/**
 * Remove remote host `hostId` from Manor (ADR-229 D8). With `destroy`, its
 * provider's `destroy()` runs first and deletes the box and its disk; if it
 * fails, nothing is removed and the error says why. Then the host is
 * forgotten: its record and every project on it (with their group
 * memberships, ADR-192), its connection, its cache, a recipe host's
 * `known_hosts` — and with `destroy`, its recipe's directory; without,
 * only the recipe's record of this host (`host.json`). The box itself is
 * left alone unless destroyed.
 */
export async function hostsRemove(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  opts: { destroy: boolean },
): Promise<void> {
  assertString(hostId, "hosts:remove.hostId");
  if (typeof opts !== "object" || opts === null) {
    throw new Error("hosts:remove.opts must be an object");
  }
  assertBoolean(opts.destroy, "hosts:remove.opts.destroy");
  if (hostId === LOCAL_HOST_ID) throw new Error("This computer can't be removed.");
  const { deps } = ctx;
  const spec = deps.projectManager.getHosts().find((h) => h.hostId === hostId)?.spec;
  if (!spec) throw new Error(`Unknown remote host ${hostId}.`);
  const registry = deps.backendRegistry;
  if (opts.destroy) {
    const provider = registry.provider(hostId);
    if (!provider?.capabilities.canDestroy || !provider.destroy) {
      throw new Error(`${registry.hostDisplayName(hostId) ?? hostId} can't be destroyed by Manor.`);
    }
    await provider.destroy();
  }
  // While the registry holds the host, its live list still names its projects.
  deps.projectManager.removeHost(hostId);
  await registry.unregister(hostId);
  // After the unregister: disposing the host's proxy writes its cache once more.
  forgetHostFiles(hostId, spec, { destroyed: opts.destroy });
  publishRendererBroadcast("projects", "changed");
}

/**
 * The names of the projects on `hostId` (ADR-229 D8): what the "Destroy
 * host and its disk" dialog lists, since the host is their source of truth
 * (ADR-227) — from the host's live list, or its cache while it is away.
 */
export function hostsProjectsOnHost(ctx: HandlerCtx<ServerDeps>, hostId: string): string[] {
  assertString(hostId, "hosts:projectsOnHost.hostId");
  ctx.deps.projectManager.assertKnownHost(hostId);
  return ctx.deps.projectManager.projectNamesOnHost(hostId);
}

export function hostsRetryConnect(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): void {
  assertString(hostId, "hosts:retryConnect.hostId");
  ctx.deps.backendRegistry.retryNow(hostId);
}

/**
 * How long `hosts.wake` waits for the host to come up before answering that
 * it is still starting: a box that takes longer goes on starting, and its
 * status says how far it got (ADR-229 D1).
 */
const HOST_WAKE_WAIT_MS = 2 * 60_000;

/**
 * Wake `hostId` and connect it (ADR-229 D1). Answers once it is connected;
 * rejects when it cannot be brought up, or with "<host> is still starting"
 * when `HOST_WAKE_WAIT_MS` passes with the box still coming up — a recipe's
 * `up` may take 15 minutes (ADR-229 D2). The start goes on either way, its
 * progress in the host's status. A host that is awake already answers at
 * once.
 */
async function hostsWake(ctx: HandlerCtx<ServerDeps>, hostId: string): Promise<void> {
  assertString(hostId, "hosts:wake.hostId");
  const registry = ctx.deps.backendRegistry;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      registry.wake(hostId),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, HOST_WAKE_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut && registry.status(hostId) === "connecting") {
    throw new Error(`${registry.hostDisplayName(hostId) ?? hostId} is still starting.`);
  }
}

/**
 * Put `hostId`'s box to sleep (ADR-229 D1). Refused for a host whose
 * provider cannot stop it — every ssh box.
 */
async function hostsStop(ctx: HandlerCtx<ServerDeps>, hostId: string): Promise<void> {
  assertString(hostId, "hosts:stop.hostId");
  await ctx.deps.backendRegistry.stop(hostId);
}

/** The ADR-178 (main) §4 checks, run through the host itself. */
export async function hostsHealthCheck(
  ctx: HandlerCtx<ServerDeps>,
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

// ── Phone access through a host's server (ADR-225 D3, D4, D6) ──

/** What the Hosts page shows for one host's server. */
export interface HostServerView {
  state: HostServerClientState;
  /** Null unless the owner channel is up. */
  status: HostServerStatus | null;
  /** Paired phones, read with the status so the two can never disagree. */
  devices: RemoteDeviceInfo[];
  /**
   * "Phones paired with this Mac can reach <host>" (ADR-228 D9): whether
   * this desktop's devices are paired here too. On by default.
   */
  linkPhones: boolean;
  /** The ids, among `devices`, of pairings this desktop minted ("via This Mac"). */
  linkedDeviceIds: string[];
  /**
   * What keeps the host's Manor running across a reboot (ADR-229 D4), from
   * the server's status: null when nothing does, or when the status could
   * not be read.
   */
  supervisor: SupervisorFacts | null;
  /**
   * "Keep Manor running when <host> restarts" as this desktop remembers it
   * (`PersistedHost.supervise`, ADR-229 D4): the switch's state, readable
   * with the host away.
   */
  supervise: boolean;
}

/** The owner channel to `hostId`'s server, or a plain reason there is none. */
function serverClient(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): HostServerClient {
  assertString(hostId, "hosts:server.hostId");
  const client = ctx.deps.backendRegistry.hostServer(hostId);
  if (!client) {
    throw new Error(
      hostId === "local"
        ? "This computer has no host server; phone access is set up in Remote control."
        : `Unknown remote host ${hostId}.`,
    );
  }
  return client;
}

/** A client that can be called now, or the error saying why not. */
function connectedServer(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): HostServerClient {
  const client = serverClient(ctx, hostId);
  if (client.state === "unsupported") {
    throw new Error(
      "Phone access isn't available on this host: it has no Manor server yet. It is set up when the host reconnects.",
    );
  }
  if (client.state !== "connected") {
    throw new Error(
      "Phone access needs the host to reconnect first. Try again once it is back.",
    );
  }
  return client;
}

/** Have the sync re-read the host's push endpoints, then tell the page its pairing changed. */
function pairingChanged(ctx: HandlerCtx<ServerDeps>, hostId: string): void {
  void Promise.resolve(ctx.deps.hostServerSync?.pairingChanged(hostId)).then(() => {
    publishRendererBroadcast("hosts", "pairingChanged", hostId);
  });
}

export async function hostsServerStatus(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): Promise<HostServerView> {
  const client = serverClient(ctx, hostId);
  const { state } = client;
  const links = {
    linkPhones: ctx.deps.projectManager.hostLinksPhones(hostId),
    linkedDeviceIds: ctx.deps.hostLinks?.linkedOn(hostId) ?? [],
    supervise: ctx.deps.projectManager.hostSupervised(hostId),
  };
  const none = { state, status: null, devices: [], ...links, supervisor: null };
  if (state !== "connected") return none;
  try {
    const [status, devices] = await Promise.all([
      client.api.hostServer.status(),
      client.api.remoteControl.listDevices(),
    ]);
    // A fresh read: keep `hosts.list`'s room and capability current with it.
    ctx.deps.backendRegistry.setServerFacts(hostId, serverFactsOf(status));
    return { state, status, devices, ...links, supervisor: status.supervisor ?? null };
  } catch (err) {
    if (err instanceof HostServerUnavailableError) return none;
    throw err;
  }
}

/**
 * "Keep Manor running when <host> restarts" (ADR-229 D4): run `manor-host
 * supervisor install` (or `uninstall`) on the host through its transport,
 * and remember the choice, so a later connect installs it again if the
 * host has lost it. Answers what supervises the host afterwards. Rejects
 * when the host is away, or has no supervisor to use ("No supervisor on
 * this host"); the choice is then left as it was.
 */
export async function hostsSetSupervised(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  on: boolean,
): Promise<SupervisorFacts | null> {
  assertString(hostId, "hosts:setSupervised.hostId");
  assertBoolean(on, "hosts:setSupervised.on");
  const { deps } = ctx;
  deps.projectManager.assertKnownHost(hostId);
  const provider = deps.backendRegistry.provider(hostId);
  if (!provider) throw new Error(`Unknown remote host ${hostId}.`);
  const facts = await runHostSupervisor(provider.transport(), on ? "install" : "uninstall");
  deps.projectManager.setHostSupervised(hostId, on);
  // The page re-reads the server's status, which now names the supervisor.
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
  return facts;
}

/** How long to wait for the server to reconnect after it restarts. */
const SERVER_RECONNECT_WAIT_MS = 15_000;

/**
 * "Encrypt keys" (ADR-236 D7): run `manor-host secrets encrypt` on the host
 * through its transport. The host's server restarts to pick the key up, so
 * wait (up to about 15 s) for the channel to come back, then tell the page
 * to re-read the server's status. Answers the key facts.
 */
export async function hostsEncryptKeys(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): Promise<SecretsFacts> {
  assertString(hostId, "hosts:encryptKeys.hostId");
  const { deps } = ctx;
  deps.projectManager.assertKnownHost(hostId);
  const provider = deps.backendRegistry.provider(hostId);
  if (!provider) throw new Error(`Unknown remote host ${hostId}.`);
  const transport = provider.transport();
  if (!transport.exec) throw new Error("This host can't run commands.");
  const facts = await runHostSecrets(transport, "encrypt");
  await waitForServerConnected(ctx, hostId);
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
  return facts;
}

/** Resolves once `hostId`'s server channel is `connected`, or after the wait. */
function waitForServerConnected(ctx: HandlerCtx<ServerDeps>, hostId: string): Promise<void> {
  const client = ctx.deps.backendRegistry.hostServer(hostId);
  if (!client || client.state === "connected") return Promise.resolve();
  return new Promise((resolve) => {
    let off: () => void = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, SERVER_RECONNECT_WAIT_MS);
    off = client.onStateChange((state) => {
      if (state === "connected") done();
    });
  });
}

export async function hostsPairDevice(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  label?: string,
): Promise<PairResult> {
  const client = connectedServer(ctx, hostId);
  const name = typeof label === "string" && label.trim() !== "" ? label.trim() : "Phone";
  const result = await client.api.remoteControl.pair(name);
  pairingChanged(ctx, hostId);
  return result;
}

export async function hostsRevokeDevice(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  deviceId: string,
): Promise<RemoteDeviceInfo[]> {
  assertString(deviceId, "hosts:revokeDevice.deviceId");
  const devices = await connectedServer(ctx, hostId).api.remoteControl.revoke(deviceId);
  pairingChanged(ctx, hostId);
  return devices;
}

export async function hostsResetPairingKeys(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
): Promise<HostServerStatus> {
  const client = connectedServer(ctx, hostId);
  const reset = () => client.api.hostServer.resetIdentity();
  // After any mint in flight on the host, whose link the reset would leave
  // pointing at a revoked device; the host's links go with the reset
  // (ADR-230 D11).
  const links = ctx.deps.hostLinks;
  const status = links ? await links.resetHost(hostId, reset) : await reset();
  pairingChanged(ctx, hostId);
  return status;
}

/**
 * "Use Linear on <host>" (ADR-227 D7): copy this computer's Linear key to the
 * host's server, or delete the copy. The key goes over the owner channel to
 * the host's own `SecretBox`; it is never returned or logged. Answers whether
 * Linear is on for the host afterwards.
 */
export async function hostsSetLinearOnHost(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  on: boolean,
): Promise<boolean> {
  if (typeof on !== "boolean") throw new Error("hosts:setLinearOnHost.on must be a boolean");
  const client = connectedServer(ctx, hostId);
  let token: string | null = null;
  if (on) {
    token = ctx.deps.linearManager.getToken();
    if (token === null) throw new Error("Connect Linear on this computer first.");
  }
  const enabled = await client.api.hostServer.setLinearToken(token);
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
  return enabled;
}

/**
 * "Phones paired with this Mac can reach <host>" (ADR-228 D9). Off revokes
 * every pairing this desktop minted there — now, or on the host's next
 * connect — and `remoteControl.linkHostPairings` mints none there again
 * until it is back on. Allowed with the host away: that is when the revoke
 * has to wait.
 */
export async function hostsSetLinkPhones(
  ctx: HandlerCtx<ServerDeps>,
  hostId: string,
  on: boolean,
): Promise<void> {
  assertString(hostId, "hosts:setLinkPhones.hostId");
  assertBoolean(on, "hosts:setLinkPhones.on");
  serverClient(ctx, hostId);
  const links = ctx.deps.hostLinks;
  if (links) await links.setLinkPhones(hostId, on);
  else ctx.deps.projectManager.setHostLinksPhones(hostId, on);
  publishRendererBroadcast("hosts", "pairingChanged", hostId);
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
  deps: Pick<ServerDeps, "backendRegistry">,
): void {
  deps.backendRegistry.onStatusChange((hosts: HostStatusInfo[]) => {
    publishRendererBroadcast("hosts", "statusChanged", hosts);
  });
  deps.backendRegistry.onHostServerStateChange((hostId, state) => {
    publishRendererBroadcast("hosts", "serverChanged", { hostId, state });
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
  // Runs the user's own recipe commands on this machine (ADR-229 D2): the
  // desktop user's call alone, and home's to answer.
  addRecipeHost: method(hostsAddRecipeHost, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  // Writes scripts this machine will run (ADR-229 D8): the desktop user's.
  createRecipe: method(hostsCreateRecipe, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  listTemplates: method(hostsListTemplates, { localOnly: true, route: LOCAL_ROUTE }),
  createCustomRecipe: method(hostsCreateCustomRecipe, {
    localOnly: true,
    mutating: true,
    route: LOCAL_ROUTE,
  }),
  // Forgets a host for every viewer, and may delete its box and disk
  // (ADR-229 D8): the desktop user's call alone, and home's to answer.
  remove: method(hostsRemove, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  projectsOnHost: method(hostsProjectsOnHost, { localOnly: true, route: LOCAL_ROUTE }),
  retryConnect: method(hostsRetryConnect, { mutating: true }),
  // A phone wakes a sleeping host through its home desktop (ADR-229 D7), so
  // `wake` is a `full` device's too: like `retryConnect`, it only connects
  // a host already listed here. Stopping one is the desktop user's call,
  // so `stop` is local. Both are home's to answer (`ROUTES`).
  wake: method(hostsWake, { mutating: true, route: LOCAL_ROUTE }),
  stop: method(hostsStop, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  healthCheck: method(hostsHealthCheck),
  // Pairing a phone with a host's server hands out a key to that host, so
  // these are `localOnly` like `remoteControl.pair` (ADR-225 D3).
  serverStatus: method(hostsServerStatus, { localOnly: true }),
  pairDevice: method(hostsPairDevice, { localOnly: true, mutating: true }),
  revokeDevice: method(hostsRevokeDevice, { localOnly: true, mutating: true }),
  resetPairingKeys: method(hostsResetPairingKeys, {
    localOnly: true,
    mutating: true,
  }),
  // Sends the Linear key to the host. `mutating` is safe for the audit line:
  // its arguments are the host id and a flag; the key is read here.
  setLinearOnHost: method(hostsSetLinearOnHost, { localOnly: true, mutating: true }),
  // Turning it off revokes phones on the host; on lets the desktop pair its
  // own there. The same grant as `pairDevice`, so local too (ADR-228 D9).
  setLinkPhones: method(hostsSetLinkPhones, { localOnly: true, mutating: true }),
  // Writes systemd units (or LaunchAgents) onto the host and runs its
  // commands there: the owner's call, and home's, which holds the transport
  // (ADR-229 D4).
  setSupervised: method(hostsSetSupervised, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
  // Runs `manor-host secrets encrypt` on the host through its transport,
  // which home holds (ADR-236 D7).
  encryptKeys: method(hostsEncryptKeys, { localOnly: true, mutating: true, route: LOCAL_ROUTE }),
};
