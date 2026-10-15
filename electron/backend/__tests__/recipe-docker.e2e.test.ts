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
 * 8. A forced drop: the box's ends of the exec streams are killed, as an
 *    API server's idle timeout would cut them. The owner channel and the
 *    host come back by themselves, to the same host server.
 * 9. A forced drop after the box moved (ADR-230 D2): the container is
 *    renamed and `up` now returns the new name, so redialling the old exec
 *    target fails. The reconnect re-runs `up` and finds it, with no
 *    connect from outside.
 * 10. A port forward carries half-close (ADR-230 D4): a client that shuts
 *    its write side after its request still gets the reply.
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
import * as net from "node:net";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HandlerCtx } from "../../bridge/method";
import { hostsRemove } from "../../bridge/handlers/hosts";
import type { ServerDeps } from "../../ipc/types";
import { hostRecipesDir } from "../../paths";
import type { HostRouting } from "../../server/host-routing";
import type { HostServerClient } from "../host-server-client";
import type { RecipeHostProvider } from "../providers/recipe-provider";
import { createRecipeFromTemplate } from "../providers/recipe-templates";
import { readRecipeHostState, recipeDir } from "../providers/recipes";
import type { BackendRegistry, HostStatusInfo } from "../registry";
import { runHostSupervisor } from "../host-supervisor";
import { pollFor } from "../../../tests/e2e/helpers/remote-host";
import {
  BOOTSTRAP_TIMEOUT_MS,
  CALLER,
  CLOSED_RELAY_URL,
  STEP_MS,
  STEP_TIMEOUT_MS,
  VERSION,
  createRecipeHarness,
  freshServerClient,
  parentCommand,
  requireTarball,
  seedProjectAndWorkspace,
  serverPid,
  type BoxExec,
  type RecipeHarness,
  type Result,
} from "./recipe-e2e-harness";

const IMAGE = process.env.MANOR_E2E_RECIPE_IMAGE ?? "manor-host:e2e";

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

const suffix = crypto.randomBytes(3).toString("hex");
const NAME = `manor-e2e-${suffix}`;
const CLONE = `manor-e2e-${suffix}-clone`;
/** Where scenario 9 moves the container to. */
const MOVED = `manor-e2e-${suffix}-moved`;
/** The file the patched `up` and `status` read a moved container's name from. */
const MOVED_TO_FILE = "e2e-moved-to";
const VOLUME = `manor-${NAME}-home`;
const CLONE_VOLUME = `manor-${CLONE}-home`;
const HOST_ID = `recipe-e2e-${suffix}`;
const onBox = dockerBox(NAME);

// ── Docker ──

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

/** Runs `sh -c command` in `container` as `manor`. */
function dockerBox(container: string): BoxExec {
  return (command, opts = {}) => docker(["exec", "-i", "-u", "manor", container, "sh", "-c", command], opts);
}

function containerState(container: string): string {
  const res = docker(["inspect", "-f", "{{.State.Status}}", container], { allowFailure: true });
  return res.code === 0 ? res.stdout.trim() : "missing";
}

describe.skipIf(SKIP !== null)("a recipe host on a real Docker daemon", () => {
  let harness: RecipeHarness;
  let registry: BackendRegistry;
  let routing: HostRouting;
  let statuses: Array<HostStatusInfo["status"]>;
  let projectId: string;
  let workspacePath: string;
  let roomId: string | null;
  const recipeId = `docker-${NAME}`;

  const provider = (): RecipeHostProvider => harness.provider();
  const server = (): HostServerClient => harness.server();
  const serverConnected = (): Promise<HostServerClient> => harness.serverConnected();
  const launchAgent = (workspace: string): Promise<string> => harness.launchAgent(workspace);
  const agentActive = (paneId: string): Promise<void> => harness.agentActive(paneId);

  beforeAll(() => {
    requireTarball();
    // The recipe, from the bundled template, as the Hosts page writes it —
    // under the worker's own $HOME (`setup-isolated-home.ts`).
    createRecipeFromTemplate("docker", { name: NAME, image: IMAGE });
    const up = path.join(recipeDir(recipeId), "up.sh");
    const script = fs.readFileSync(up, "utf-8");
    const marker = '-e "MANOR_INSTANCE_ID=$name" \\\n';
    expect(script).toContain(marker);
    // A recipe is the user's to edit: this one keeps the box off the
    // production relay. And for scenario 9, which moves the container,
    // once `e2e-moved-to` exists in the recipe's folder, `up` and `status`
    // name the container it holds. The
    // volume keeps its name, as a real move's disk would.
    const volumeLine = 'volume="manor-$name-home"\n';
    const moved = `if [ -s "$MANOR_RECIPE_DIR/${MOVED_TO_FILE}" ]; then name=$(cat "$MANOR_RECIPE_DIR/${MOVED_TO_FILE}"); fi\n`;
    expect(script).toContain(volumeLine);
    fs.writeFileSync(
      up,
      script
        .replace(marker, () => `${marker}      -e MANOR_RELAY_URL=${CLOSED_RELAY_URL} \\\n`)
        .replace(volumeLine, () => `${volumeLine}${moved}`),
    );
    const status = path.join(recipeDir(recipeId), "status.sh");
    const statusScript = fs.readFileSync(status, "utf-8");
    const nameLine = "name=${MANOR_DOCKER_NAME:?MANOR_DOCKER_NAME is not set}\n";
    expect(statusScript).toContain(nameLine);
    fs.writeFileSync(status, statusScript.replace(nameLine, () => `${nameLine}${moved}`));

    harness = createRecipeHarness({ hostId: HOST_ID, label: NAME, via: "docker" });
    ({ registry, routing, statuses } = harness);
  });

  afterAll(async () => {
    await registry?.disconnectAll();
    // For a look inside after a failure: `docker rm -f` and `docker volume rm` by hand.
    if (process.env.MANOR_E2E_RECIPE_KEEP === "1") return;
    for (const name of [NAME, CLONE, MOVED]) docker(["rm", "-f", name], { allowFailure: true });
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
      expect(onBox('"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe(VERSION);

      const client = await serverConnected();
      // The entrypoint waited for the shim, then became `manor-host supervise`,
      // which adopted the server the bridge started (or started its own) and
      // recorded itself as the box's supervisor.
      await pollFor(
        "the supervisor holding the server",
        async () => ((await client.api.hostServer.status()).supervisor?.kind === "container" ? true : null),
        STEP_MS,
      );
      onBox('kill -0 "$(cat "$HOME/.manor/remote/supervise.pid")"');
      const pid = serverPid(onBox);
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
      ({ projectId, workspacePath } = await seedProjectAndWorkspace(onBox, client));

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
        () => (onBox('test -f "$HOME/busy-hook-ran"', { allowFailure: true }).code === 0 ? true : null),
        STEP_MS,
      );
      const status = await server().api.hostServer.status();
      expect(status.busy).toBe(true);
      expect(status.hooks).toEqual({ onBusy: true, onIdle: true });
      expect(onBox('cat "$HOME/.manor/remote/server/logs/hooks.log"').stdout).toContain("on-busy");
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
    "10. carries a half-close through a port forward: the client that shut its write side gets the reply",
    async () => {
      // Replies only once it has read the whole request, that is on EOF.
      docker([
        "exec",
        "-d",
        "-u",
        "manor",
        NAME,
        "node",
        "-e",
        "require('net').createServer({ allowHalfOpen: true }, (s) => { let d = ''; " +
          "s.on('data', (c) => (d += c)); s.on('end', () => s.end('got:' + d)); })" +
          ".listen(4568, '127.0.0.1')",
      ]);
      const forward = await provider().forwardPort(4568);
      try {
        /** One request: write, shut the write side, read to the end. */
        const ask = () =>
          new Promise<string>((resolve) => {
            const socket = net.connect({ host: "127.0.0.1", port: forward.localPort, allowHalfOpen: true });
            let reply = "";
            const timer = setTimeout(() => {
              socket.destroy();
              resolve(reply);
            }, 10_000);
            socket.on("connect", () => socket.end("ping"));
            socket.on("data", (chunk) => (reply += chunk.toString()));
            socket.on("end", () => socket.end());
            socket.on("close", () => {
              clearTimeout(timer);
              resolve(reply);
            });
            socket.on("error", () => {});
          });
        // Retried only until the server on the box listens: before ADR-230
        // D4 every answer was empty, since the pipe tore down on the EOF.
        const reply = await pollFor(
          "the reply after a half-close",
          async () => {
            const got = await ask();
            return got === "got:ping" ? got : null;
          },
          STEP_MS,
          500,
        );
        expect(reply).toBe("got:ping");
      } finally {
        forward.dispose();
      }
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "8. reconnects by itself after its exec streams are cut, to the same host server",
    async () => {
      const client = await serverConnected();
      const pid = serverPid(onBox);
      expect(pid).not.toBeNull();
      const seen: string[] = [];
      const unsubscribe = client.onStateChange((state) => seen.push(state));
      try {
        // The brackets keep `sh -c`'s own command line from matching.
        const killed = onBox('pkill -9 -f "[s]erver-bridge|[r]emote-bridge"', {
          allowFailure: true,
        });
        expect(killed.code, "no bridge process to kill").toBe(0);
        await pollFor("the owner channel dropping", () => (seen.some((s) => s !== "connected") ? true : null), STEP_MS, 200);
        await pollFor("the owner channel back", () => (client.state === "connected" ? true : null), STEP_MS);
        await pollFor("the host back", () => (registry.status(HOST_ID) === "connected" ? true : null), STEP_MS);
      } finally {
        unsubscribe();
      }
      // The supervised server never noticed: only the streams to it went.
      expect(serverPid(onBox)).toBe(pid);
      expect((await client.api.hostServer.status()).relay.roomId).toBe(roomId);
      const paneId = await launchAgent(workspacePath);
      await agentActive(paneId);
    },
    STEP_TIMEOUT_MS * 2,
  );

  it(
    "9. re-runs up while reconnecting after the box moved, and finds it at its new exec target",
    async () => {
      const client = await serverConnected();
      const pid = serverPid(onBox);
      expect(pid).not.toBeNull();
      const movedTo = path.join(recipeDir(recipeId), MOVED_TO_FILE);
      const seen: string[] = [];
      const unsubscribe = client.onStateChange((state) => seen.push(state));
      const mark = statuses.length;
      try {
        // The box moves: its old exec target (`docker exec … NAME`) is gone,
        // and only a new `up` says where it went. The streams already open
        // ride the container's id, so cut them as scenario 8 does.
        fs.writeFileSync(movedTo, MOVED);
        docker(["rename", NAME, MOVED]);
        const killed = dockerBox(MOVED)('pkill -9 -f "[s]erver-bridge|[r]emote-bridge"', { allowFailure: true });
        expect(killed.code, "no bridge process to kill").toBe(0);

        await pollFor(
          "the host reconnecting",
          () => (statuses.slice(mark).includes("reconnecting") ? true : null),
          STEP_MS,
          200,
        );
        // Nothing here connects: the reconnect loop's own `up` has to find it.
        await pollFor("the host back", () => (registry.status(HOST_ID) === "connected" ? true : null), STEP_MS * 2);
        await pollFor("the owner channel back", () => (client.state === "connected" ? true : null), STEP_MS);
        expect(seen.some((s) => s !== "connected")).toBe(true);
        expect(readRecipeHostState(recipeDir(recipeId), HOST_ID)?.resource).toEqual({ container: MOVED });
        // The same host server, now reached under the new name.
        expect(serverPid(dockerBox(MOVED))).toBe(pid);
        expect((await client.api.hostServer.status()).relay.roomId).toBe(roomId);
        const paneId = await launchAgent(workspacePath);
        await agentActive(paneId);
      } finally {
        unsubscribe();
        // Back where the later scenarios expect it, and bound to it again.
        fs.rmSync(movedTo, { force: true });
        if (containerState(MOVED) !== "missing") docker(["rename", MOVED, NAME]);
        await registry.disconnect(HOST_ID);
        await registry.ensureConnected(HOST_ID);
      }
      await serverConnected();
      expect(serverPid(onBox)).toBe(pid);
    },
    STEP_TIMEOUT_MS * 4,
  );

  it(
    "2. keeps the host server across a reboot, in the same room, sealed off the volume",
    async () => {
      expect(roomId).toBeTruthy();
      // The desktop lets go first: whatever runs after the restart, nothing
      // here started it.
      await registry.disconnect(HOST_ID);
      const before = serverPid(onBox);
      expect(before).not.toBeNull();

      docker(["restart", NAME], { timeoutMs: STEP_TIMEOUT_MS });
      const pid = await pollFor("the host server after the restart", () => serverPid(onBox), STEP_MS, 1_000);
      expect(parentCommand(onBox, pid)).toContain("supervise");
      expect(registry.status(HOST_ID)).toBe("disconnected");

      const backend = onBox('cat "$HOME/.manor/remote/server/secret-backend"').stdout;
      expect(JSON.parse(backend)).toEqual({ backend: "key-file" });
      // The key is a bind mount from the recipe's directory, not on the volume.
      onBox('test "$MANOR_SECRET_KEY_FILE" = /run/secrets/manor-key && test -s "$MANOR_SECRET_KEY_FILE"');
      expect(fs.existsSync(path.join(recipeDir(recipeId), "secret.key"))).toBe(true);

      const fresh = await freshServerClient(["docker", "exec", "-i", "-u", "manor", NAME], NAME);
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
      onBox(`test -d '${woken!.path}'`);
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
      await pollFor("the clone's host server", () => serverPid(dockerBox(CLONE)), STEP_MS, 1_000);

      const fresh = await freshServerClient(["docker", "exec", "-i", "-u", "manor", CLONE], CLONE);
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
      expect(dockerBox(CLONE)('grep -c "cloned data dir: identity reset" "$HOME/.manor/remote/server/logs/host-server.log"').stdout.trim()).not.toBe("0");
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
