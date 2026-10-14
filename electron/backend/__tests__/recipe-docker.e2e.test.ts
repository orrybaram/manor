/**
 * Recipe-host E2E against a real Docker daemon (ADR-229 ticket 9).
 *
 * Everything else in the recipe stack is tested against fakes; this drives
 * the desktop's real `BackendRegistry` (with a real `RecipeHostProvider`
 * built from the bundled `docker` template), `HostServerClient` and
 * `HostRouting` against a real container from `docker/host-image`:
 *
 * 1. `up` over exec: the template's `up` starts the container, bootstrap
 *    installs the tarball over `docker exec`, the host server ends up under
 *    `manor-host supervise`, adoption completes, and a workspace and an
 *    agent (`manor-e2e-agent`) run there.
 * 2. A reboot (`docker restart`) brings the host server back with no
 *    desktop connect, in the same relay room, sealed by `key-file` with the
 *    key off the volume; an agent launched afterwards starts.
 * 3. Stop and wake: `stop` leaves the host `sleeping` with no reconnects,
 *    and a routed write (create a workspace) wakes it and succeeds.
 * 4. Clone detection: a second container on a copy of the first's volume,
 *    with another `MANOR_INSTANCE_ID`, gets a new room and keeps projects.
 * 5. The `on-busy` box hook runs when an agent turns busy.
 * 6. A port forward over exec reaches a server on the container.
 * 7. Remove with destroy: the container and volume are gone, and the host
 *    is no longer listed.
 *
 * Skipped unless MANOR_E2E_RECIPE=1 — `pnpm test:unit` never runs it. Run
 * it through the harness, which builds the app, the host tarball and the
 * image (`manor-host:e2e`):
 *
 *   node scripts/test-remote-e2e.mjs --recipe
 *
 * Every container and volume it makes is removed afterwards; the image is
 * kept.
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Caller, HandlerCtx } from "../../bridge/method";
import { hostsRemove } from "../../bridge/handlers/hosts";
import type { ServerDeps } from "../../ipc/types";
import { hostRecipesDir } from "../../paths";
import { HostRouting } from "../../server/host-routing";
import { HostServerClient } from "../host-server-client";
import { CommandHostProvider } from "../providers/command-provider";
import { RecipeHostProvider } from "../providers/recipe-provider";
import { createRecipeFromTemplate } from "../providers/recipe-templates";
import { recipeDir } from "../providers/recipes";
import { BackendRegistry, type HostStatusInfo } from "../registry";
import { ensureRemoteHost, hostTarballPath } from "../remote-bootstrap";
import { runHostSupervisor } from "../host-supervisor";
import type { HostSpec, WorkspaceBackend } from "../types";
import type { EnsureRemoteHost } from "../../terminal-host/bridge-spawner";
import { pollFor } from "../../../tests/e2e/helpers/remote-host";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version: string }
).version;
const TARBALL = hostTarballPath(VERSION, path.join(ROOT, "dist-electron"));
const STUB_DIR = path.join(ROOT, "tests", "e2e", "remote-host");
const IMAGE = process.env.MANOR_E2E_RECIPE_IMAGE ?? "manor-host:e2e";
/** What the box's host server dials: never the production relay. */
const CLOSED_RELAY_URL = "http://127.0.0.1:9";
const REMOTE_AGENT = "~/.manor-e2e/bin/manor-e2e-agent";

function skipReason(): string | null {
  if (process.env.MANOR_E2E_RECIPE !== "1") {
    return (
      "recipe-host E2E needs Docker: run `node scripts/test-remote-e2e.mjs --recipe`, " +
      "which builds the image and sets MANOR_E2E_RECIPE=1. See docs/remote-hosts.md#testing."
    );
  }
  const res = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf-8" });
  if (res.error || res.status !== 0) return "MANOR_E2E_RECIPE=1 but the docker daemon isn't reachable";
  if (spawnSync("docker", ["image", "inspect", IMAGE]).status !== 0) {
    return `MANOR_E2E_RECIPE=1 but the image ${IMAGE} doesn't exist (build docker/host-image)`;
  }
  return null;
}

const SKIP = skipReason();
if (SKIP && process.env.MANOR_E2E_RECIPE === "1") {
  // Asked for, but misconfigured: say so rather than skip silently.
  throw new Error(SKIP);
}

/** node-pty compiles from source during the first bootstrap. */
const BOOTSTRAP_TIMEOUT_MS = 15 * 60_000;
const STEP_TIMEOUT_MS = 90_000;
const STEP_MS = 60_000;

const suffix = crypto.randomBytes(3).toString("hex");
const NAME = `manor-e2e-${suffix}`;
const CLONE = `manor-e2e-${suffix}-clone`;
const VOLUME = `manor-${NAME}-home`;
const CLONE_VOLUME = `manor-${CLONE}-home`;
const HOST_ID = `recipe-e2e-${suffix}`;

// ── Docker ──

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

function docker(args: string[], opts: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {}): Result {
  const res = spawnSync("docker", args, {
    encoding: "utf-8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (res.error) throw res.error;
  const out = { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (!opts.allowFailure && out.code !== 0) {
    throw new Error(`docker ${args.join(" ")} exited ${out.code}: ${out.stderr.trim()}`);
  }
  return out;
}

/** Run `command` in `container` as `manor`, through `sh -c`. */
function onBox(
  container: string,
  command: string,
  opts: { input?: string; allowFailure?: boolean } = {},
): Result {
  return docker(["exec", "-i", "-u", "manor", container, "sh", "-c", command], opts);
}

function containerState(container: string): string {
  const res = docker(["inspect", "-f", "{{.State.Status}}", container], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : "missing";
}

/** The host server's pid when it runs and its socket is there, else null. */
function serverPid(container: string): number | null {
  const res = onBox(
    container,
    'p=$(cat "$HOME/.manor/remote/server/server.pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null && ' +
      'test -S "$HOME/.manor/remote/server/server.sock" && echo "$p"',
    { allowFailure: true },
  );
  const pid = Number(res.stdout.trim());
  return res.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The command line of `pid`'s parent, on the box. */
function parentCommand(container: string, pid: number): string {
  return onBox(container, `ps -o args= -p "$(ps -o ppid= -p ${pid} | tr -d ' ')"`, { allowFailure: true })
    .stdout.trim();
}

// ── The desktop's side ──

const ensureHost: EnsureRemoteHost = async (target, version, exec) => {
  if (!version) return;
  await ensureRemoteHost(target, version, exec, {
    via: "docker",
    loadTarball: () => fs.readFileSync(TARBALL),
  });
};

/** A local backend nothing here calls: the registry only listens to it. */
const LOCAL_STUB = { pty: { onEvent: () => () => {} } } as unknown as WorkspaceBackend;

const CALLER: Caller = { id: "recipe-e2e", callerClass: "local" };

/** An owner channel of its own to `container`'s host server, as a fresh desktop dials it. */
async function freshServerClient(container: string): Promise<{
  client: HostServerClient;
  dispose: () => Promise<void>;
}> {
  const provider = new CommandHostProvider(["docker", "exec", "-i", "-u", "manor", container], {
    label: container,
    ensureRemoteHost: ensureHost,
  });
  const client = new HostServerClient({
    hostId: `${container}-fresh`,
    open: () => provider.openServerChannel(),
  });
  await pollFor("a fresh owner channel", async () => ((await client.connect()) ? true : null), STEP_MS, 1_000);
  return {
    client,
    dispose: async () => {
      client.dispose();
      await provider.dispose();
      await provider.transport().dispose();
    },
  };
}

describe.skipIf(SKIP !== null)("a recipe host on a real Docker daemon", () => {
  let registry: BackendRegistry;
  let routing: HostRouting;
  let statuses: Array<HostStatusInfo["status"]>;
  let projectId: string;
  let projectPath: string;
  let workspacePath: string;
  let roomId: string | null;
  const recipeId = `docker-${NAME}`;

  function provider(): RecipeHostProvider {
    const p = registry.provider(HOST_ID);
    if (!(p instanceof RecipeHostProvider)) throw new Error("the host has no recipe provider");
    return p;
  }

  function server(): HostServerClient {
    const client = registry.hostServer(HOST_ID);
    if (!client) throw new Error("the host has no owner channel");
    return client;
  }

  async function serverConnected(): Promise<HostServerClient> {
    const client = server();
    await pollFor("the owner channel", () => (client.state === "connected" ? true : null), STEP_MS);
    return client;
  }

  /** Launch the stub agent in `workspace` through the server's own route, as the CLI does. */
  async function launchAgent(workspace: string): Promise<string> {
    const answer = await server().api.hostServer.control("POST", "/agents", {
      workspacePath: workspace,
      agentCommand: REMOTE_AGENT,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const paneId = (answer.body as { paneId?: unknown }).paneId;
    expect(typeof paneId).toBe("string");
    return paneId as string;
  }

  async function agentActive(paneId: string): Promise<void> {
    await pollFor(
      `the agent in ${paneId} reporting status`,
      async () => {
        const agents = await server().api.agents.getAll();
        const agent = agents.find((a) => a.paneId === paneId);
        return agent && ["thinking", "working", "requires_input"].includes(agent.lastAgentStatus ?? "")
          ? agent
          : null;
      },
      STEP_MS,
      500,
    );
  }

  beforeAll(() => {
    if (!fs.existsSync(TARBALL)) {
      throw new Error(
        `${TARBALL} is missing — run \`pnpm build && node scripts/build-host-tarball.mjs\` ` +
          "(scripts/test-remote-e2e.mjs does both unless --no-build).",
      );
    }
    // The recipe, from the bundled template, as the Hosts page writes it —
    // under the worker's own $HOME (`setup-isolated-home.ts`).
    createRecipeFromTemplate("docker", { name: NAME, image: IMAGE });
    const up = path.join(recipeDir(recipeId), "up.sh");
    const script = fs.readFileSync(up, "utf-8");
    const marker = '-e "MANOR_INSTANCE_ID=$name" \\\n';
    expect(script).toContain(marker);
    // A recipe is the user's to edit: this one keeps the box off the
    // production relay.
    fs.writeFileSync(up, script.replace(marker, `${marker}      -e MANOR_RELAY_URL=${CLOSED_RELAY_URL} \\\n`));

    statuses = [];
    registry = new BackendRegistry({
      local: LOCAL_STUB,
      remoteVersion: VERSION,
      createProvider: (hostId, spec: HostSpec, opts) => {
        if (spec.kind !== "recipe") throw new Error("a recipe host only");
        return new RecipeHostProvider(hostId, spec.recipeId, {
          onBootstrapProgress: opts.onBootstrapProgress,
          ensureRemoteHost: ensureHost,
        });
      },
      hostProxy: {
        bus: { publish: () => {} } as never,
        label: () => NAME,
      },
      isAdopted: () => true,
    });
    registry.onStatusChange((hosts) => {
      const mine = hosts.find((h) => h.hostId === HOST_ID);
      if (mine) statuses.push(mine.status);
    });
    routing = new HostRouting({
      registry,
      isAdopted: () => true,
      hasLocalProject: () => false,
      pendingCommands: { peek: () => undefined, take: () => undefined } as never,
      decorateProject: (result) => result,
      bus: { publish: () => {}, publishTo: () => {} } as never,
      handOver: async () => {},
    });
  });

  afterAll(async () => {
    await registry?.disconnectAll();
    // For a look inside after a failure: `docker rm -f` and `docker volume rm` by hand.
    if (process.env.MANOR_E2E_RECIPE_KEEP === "1") return;
    for (const name of [NAME, CLONE]) docker(["rm", "-f", name], { allowFailure: true });
    for (const volume of [VOLUME, CLONE_VOLUME]) docker(["volume", "rm", "-f", volume], { allowFailure: true });
  }, STEP_TIMEOUT_MS);

  it(
    "1. brings the docker template up over exec, under supervise, adopted, with a workspace and an agent",
    async () => {
      registry.register(HOST_ID, { kind: "recipe", recipeId });
      expect(registry.list().find((h) => h.hostId === HOST_ID)).toMatchObject({
        providerKind: "recipe",
        capabilities: { canStop: true, canDestroy: true, autoSleep: false },
      });

      await registry.ensureConnected(HOST_ID);
      expect(registry.status(HOST_ID)).toBe("connected");
      expect(containerState(NAME)).toBe("running");
      expect(onBox(NAME, '"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe(VERSION);

      const client = await serverConnected();
      // The entrypoint waited for the shim, then became `manor-host supervise`,
      // which adopted the server the bridge started (or started its own) and
      // recorded itself as the box's supervisor.
      await pollFor(
        "the supervisor holding the server",
        async () => ((await client.api.hostServer.status()).supervisor?.kind === "container" ? true : null),
        STEP_MS,
      );
      onBox(NAME, 'kill -0 "$(cat "$HOME/.manor/remote/supervise.pid")"');
      const pid = serverPid(NAME);
      expect(pid).not.toBeNull();
      // What `HostServerSync` (or the Hosts page's switch) runs: harmless now.
      expect(await runHostSupervisor(provider().transport(), "install")).toEqual({ kind: "container" });

      // Adoption with nothing to hand over: the box owns its records.
      const adopted = await client.api.hostServer.adopt({
        projects: [],
        agents: [],
        layout: { version: 1, takenAt: new Date().toISOString(), workspaces: {}, lastActiveWorkspacePath: null },
      } as never);
      expect(adopted.ownership).toBe("host");
      roomId = adopted.relay.roomId;

      // A project on the box, then a workspace in it.
      const stubs = ["manor-e2e-agent", "fire-hook"];
      onBox(NAME, 'mkdir -p "$HOME/.manor-e2e/bin"');
      for (const stub of stubs) {
        onBox(NAME, `cat > "$HOME/.manor-e2e/bin/${stub}" && chmod 755 "$HOME/.manor-e2e/bin/${stub}"`, {
          input: fs.readFileSync(path.join(STUB_DIR, stub), "utf-8"),
        });
      }
      onBox(
        NAME,
        [
          "set -e",
          'git config --global user.email e2e@manor.local',
          'git config --global user.name "Manor E2E"',
          // A bare origin on the box, so a worktree's fetch has somewhere to go.
          'git init -q --bare -b main "$HOME/seed.git"',
          'git init -q -b main "$HOME/seed-work"',
          'cd "$HOME/seed-work"',
          "echo seeded > README.md",
          "git add README.md",
          "git commit -q -m init",
          'git push -q "$HOME/seed.git" main',
          'cd "$HOME"',
          'rm -rf "$HOME/seed-work"',
          'git clone -q "$HOME/seed.git" "$HOME/proj"',
        ].join("; "),
      );
      projectPath = "/home/manor/proj";
      const project = await client.api.projects.add("proj", projectPath);
      projectId = project.id;
      const withWorkspace = await client.api.projects.createWorktree(projectId, "e2e-one");
      workspacePath =
        withWorkspace?.workspaces.find((w) => w.path !== projectPath)?.path ??
        (() => {
          throw new Error(`no worktree in ${JSON.stringify(withWorkspace?.workspaces)}`);
        })();
      onBox(NAME, `test -d '${workspacePath}'`);

      // The box hook scenario 5 checks: the template wrote a no-op on-busy.
      onBox(NAME, 'test -x "$HOME/.manor/remote/hooks/on-busy"');
      onBox(
        NAME,
        'printf \'#!/bin/sh\\ntouch "$HOME/busy-hook-ran"\\n\' > "$HOME/.manor/remote/hooks/on-busy"',
      );

      const paneId = await launchAgent(workspacePath);
      await agentActive(paneId);
    },
    BOOTSTRAP_TIMEOUT_MS,
  );

  it(
    "5. runs the on-busy hook on the box when an agent works",
    async () => {
      await pollFor(
        "the on-busy hook's file",
        () => (onBox(NAME, 'test -f "$HOME/busy-hook-ran"', { allowFailure: true }).code === 0 ? true : null),
        STEP_MS,
      );
      const status = await server().api.hostServer.status();
      expect(status.busy).toBe(true);
      expect(status.hooks).toEqual({ onBusy: true, onIdle: true });
      expect(onBox(NAME, 'cat "$HOME/.manor/remote/server/logs/hooks.log"').stdout).toContain("on-busy");
      // The desktop hearing it (`HostServerSync` → `setBusy`) is unit-tested
      // (host-idle-stop, registry); nothing here runs that sync.
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "6. forwards a port to the container over exec",
    async () => {
      docker([
        "exec",
        "-d",
        "-u",
        "manor",
        NAME,
        "node",
        "-e",
        "require('http').createServer((q, s) => s.end('hello from the box')).listen(4567, '127.0.0.1')",
      ]);
      const forward = await provider().forwardPort(4567);
      try {
        const body = await pollFor(
          "the forwarded page",
          async () => {
            const res = await fetch(`http://127.0.0.1:${forward.localPort}/`);
            return res.ok ? await res.text() : null;
          },
          STEP_MS,
          500,
        );
        expect(body).toBe("hello from the box");
      } finally {
        forward.dispose();
      }
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "2. keeps the host server across a reboot, in the same room, sealed off the volume",
    async () => {
      expect(roomId).toBeTruthy();
      // The desktop lets go first: whatever runs after the restart, nothing
      // here started it.
      await registry.disconnect(HOST_ID);
      const before = serverPid(NAME);
      expect(before).not.toBeNull();

      docker(["restart", NAME], { timeoutMs: STEP_TIMEOUT_MS });
      const pid = await pollFor("the host server after the restart", () => serverPid(NAME), STEP_MS, 1_000);
      expect(parentCommand(NAME, pid)).toContain("supervise");
      expect(registry.status(HOST_ID)).toBe("disconnected");

      const backend = onBox(NAME, 'cat "$HOME/.manor/remote/server/secret-backend"').stdout;
      expect(JSON.parse(backend)).toEqual({ backend: "key-file" });
      // The key is a bind mount from the recipe's directory, not on the volume.
      onBox(NAME, 'test "$MANOR_SECRET_KEY_FILE" = /run/secrets/manor-key && test -s "$MANOR_SECRET_KEY_FILE"');
      expect(fs.existsSync(path.join(recipeDir(recipeId), "secret.key"))).toBe(true);

      const fresh = await freshServerClient(NAME);
      try {
        const status = await fresh.client.api.hostServer.status();
        expect(status.relay.roomId).toBe(roomId);
        expect(status.secretBackend).toBe("key-file");
        expect(status.secretKeyOnVolume).toBeFalsy();
        expect(status.identityReset ?? null).toBeNull();
        expect(status.supervisor).toEqual({ kind: "container" });
      } finally {
        await fresh.dispose();
      }

      // The desktop comes back; an agent launched now starts, from a daemon
      // the supervisor started with its own minimal environment.
      await registry.ensureConnected(HOST_ID);
      await serverConnected();
      const paneId = await launchAgent(workspacePath);
      await agentActive(paneId);
    },
    STEP_TIMEOUT_MS * 2,
  );

  it(
    "3. stops into sleeping with no reconnects, and a routed write wakes it",
    async () => {
      await registry.stop(HOST_ID);
      expect(registry.status(HOST_ID)).toBe("sleeping");
      expect(containerState(NAME)).toBe("exited");

      const mark = statuses.length;
      await new Promise((r) => setTimeout(r, 10_000));
      expect(statuses.slice(mark).filter((s) => s !== "sleeping")).toEqual([]);
      expect(registry.status(HOST_ID)).toBe("sleeping");
      expect(containerState(NAME)).toBe("exited");

      const result = (await routing.invoke(
        HOST_ID,
        "projects",
        "createWorktree",
        [projectId, "woken"],
        CALLER,
      )) as { workspaces: Array<{ path: string }> } | null;
      expect(registry.status(HOST_ID)).toBe("connected");
      expect(containerState(NAME)).toBe("running");
      const woken = result?.workspaces.find((w) => w.path.endsWith("woken"));
      expect(woken, JSON.stringify(result?.workspaces)).toBeTruthy();
      onBox(NAME, `test -d '${woken!.path}'`);
    },
    STEP_TIMEOUT_MS * 3,
  );

  it(
    "4. gives a clone of the volume its own room, and keeps its projects",
    async () => {
      docker(["volume", "create", CLONE_VOLUME]);
      docker([
        "run",
        "--rm",
        "-u",
        "0",
        "-v",
        `${VOLUME}:/from:ro`,
        "-v",
        `${CLONE_VOLUME}:/to`,
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "cp -a /from/. /to/",
      ]);
      const keyFile = path.join(recipeDir(recipeId), "secret.key");
      docker([
        "run",
        "-d",
        "--name",
        CLONE,
        "-v",
        `${CLONE_VOLUME}:/home/manor`,
        "-v",
        `${keyFile}:/run/secrets/manor-key:ro`,
        "-e",
        "MANOR_SECRET_KEY_FILE=/run/secrets/manor-key",
        "-e",
        `MANOR_INSTANCE_ID=${CLONE}`,
        "-e",
        `MANOR_RELAY_URL=${CLOSED_RELAY_URL}`,
        IMAGE,
      ]);
      await pollFor("the clone's host server", () => serverPid(CLONE), STEP_MS, 1_000);

      const fresh = await freshServerClient(CLONE);
      try {
        const status = await fresh.client.api.hostServer.status();
        expect(status.identityReset).toBe("cloned");
        expect(status.relay.roomId).toBeTruthy();
        expect(status.relay.roomId).not.toBe(roomId);
        expect(status.ownership).toBe("host");
        const projects = await fresh.client.api.projects.getAll();
        expect(projects.map((p) => p.id)).toContain(projectId);
      } finally {
        await fresh.dispose();
      }
      expect(onBox(CLONE, 'grep -c "cloned data dir: identity reset" "$HOME/.manor/remote/server/logs/host-server.log"').stdout.trim()).not.toBe("0");
      // The original keeps its own room.
      expect((await server().api.hostServer.status()).relay.roomId).toBe(roomId);
      docker(["rm", "-f", CLONE]);
      docker(["volume", "rm", CLONE_VOLUME]);
    },
    STEP_TIMEOUT_MS * 2,
  );

  it(
    "7. removes the host with destroy: container, volume and recipe gone, host unlisted",
    async () => {
      const removed: string[] = [];
      const ctx = {
        caller: CALLER,
        deps: {
          backendRegistry: registry,
          projectManager: {
            getHosts: () => [{ hostId: HOST_ID, spec: { kind: "recipe", recipeId } }],
            removeHost: (hostId: string) => removed.push(hostId),
          },
        },
      } as unknown as HandlerCtx<ServerDeps>;
      await hostsRemove(ctx, HOST_ID, { destroy: true });

      expect(removed).toEqual([HOST_ID]);
      expect(registry.list().map((h) => h.hostId)).not.toContain(HOST_ID);
      expect(containerState(NAME)).toBe("missing");
      expect(docker(["volume", "inspect", VOLUME], { allowFailure: true }).code).not.toBe(0);
      expect(fs.existsSync(path.join(hostRecipesDir(), recipeId))).toBe(false);
    },
    STEP_TIMEOUT_MS,
  );
});
