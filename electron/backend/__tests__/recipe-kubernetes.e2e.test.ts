/**
 * Recipe-host E2E against a real Kubernetes cluster (ADR-231 D3).
 *
 * The `kubernetes` template's counterpart of `recipe-docker.e2e.test.ts`:
 * the desktop's real `BackendRegistry` (with a real `RecipeHostProvider`
 * built from the bundled `kubernetes` template), `HostServerClient` and
 * `HostRouting`, against a StatefulSet of the `docker/host-image` image on
 * a kind cluster. Scenarios are numbered like the Docker suite's:
 *
 * 1. `up` over `kubectl exec`: the template's `up` creates the namespace
 *    and the Secret and rolls the StatefulSet out, bootstrap pipes the
 *    tarball over `kubectl exec -i`, the host server ends up under
 *    `manor-host supervise`, adoption completes, and a workspace and an
 *    agent (`manor-e2e-agent`) run there.
 * 2. The pod is deleted, the closest thing to a node reboot or a
 *    reschedule. A connected desktop reconnects by itself and never goes to
 *    `sleeping` while the pod restarts (C1). With the desktop disconnected,
 *    the host server comes back under `supervise` with no connect, in the
 *    same relay room, sealed by `key-file` from the Secret; an agent
 *    launched afterwards starts.
 * 3. Stop and wake: `stop` scales to 0 and leaves the host `sleeping` with
 *    no reconnects, and a routed write (create a workspace) scales it back
 *    to 1 and succeeds.
 * 5. The `on-busy` box hook runs when an agent turns busy.
 * 6. A port forward over `kubectl exec` reaches a server in the pod.
 * 7. Remove with destroy: the StatefulSet, the claim `home-<name>-0` and
 *    the Secret are gone, and the host is no longer listed.
 * 8. A forced drop: the box's ends of the exec streams are killed, as an
 *    API server's idle timeout would cut them. The owner channel and the
 *    host come back by themselves, to the same host server.
 * 10. A port forward carries half-close (ADR-230 D4): a client that shuts
 *    its write side after its request still gets the reply.
 *
 * Not here (the Docker suite covers them with the same desktop code): clone
 * detection (4), since copying a claim in kind needs a helper pod, and the
 * moved box (9), since a StatefulSet's pod keeps its name.
 *
 * Skipped unless MANOR_E2E_K8S=1 — `pnpm test:unit` never runs it. Run it
 * through the harness, which brings up a kind cluster with its own
 * kubeconfig, builds the app, the host tarball and the image
 * (`manor-host:e2e`) and loads the image into the cluster:
 *
 *   node scripts/test-remote-e2e.mjs --k8s
 *
 * Its namespace is deleted afterwards; the harness deletes the cluster.
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
import { recipeDir } from "../providers/recipes";
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

const IMAGE = process.env.MANOR_E2E_K8S_IMAGE ?? "manor-host:e2e";

function skipReason(): string | null {
  if (process.env.MANOR_E2E_K8S !== "1") {
    return (
      "Kubernetes recipe-host E2E needs a cluster: run `node scripts/test-remote-e2e.mjs --k8s`, " +
      "which brings up kind, loads the image and sets MANOR_E2E_K8S=1. See docs/remote-hosts.md#testing."
    );
  }
  const nodes = spawnSync("kubectl", ["get", "nodes", "-o", "jsonpath={.items[*].metadata.name}"], {
    encoding: "utf-8",
  });
  if (nodes.error || nodes.status !== 0 || nodes.stdout.trim() === "") {
    return `MANOR_E2E_K8S=1 but kubectl can't reach the cluster (KUBECONFIG=${process.env.KUBECONFIG ?? "unset"})`;
  }
  // A kind node is a container: ask its runtime. The node's own image list
  // in its status lags a `kind load` by minutes.
  const ref = IMAGE.includes("/") ? IMAGE : `docker.io/library/${IMAGE}`;
  const loaded = nodes.stdout
    .trim()
    .split(/\s+/)
    .every((node) => spawnSync("docker", ["exec", node, "crictl", "inspecti", ref]).status === 0);
  if (!loaded) return `MANOR_E2E_K8S=1 but the image ${IMAGE} isn't loaded into the kind nodes (kind load docker-image)`;
  return null;
}

const SKIP = skipReason();
if (SKIP && process.env.MANOR_E2E_K8S === "1") {
  // Asked for, but misconfigured: say so rather than skip silently.
  throw new Error(SKIP);
}

const suffix = crypto.randomBytes(3).toString("hex");
const NAMESPACE = `manor-e2e-${suffix}`;
const NAME = `manor-e2e-${suffix}`;
const POD = `${NAME}-0`;
const HOST_ID = `recipe-k8s-e2e-${suffix}`;
/** The recipe's own way in, as its `up` prints it: the command goes after `--`. */
const EXEC_PREFIX = ["kubectl", "-n", NAMESPACE, "exec", "-i", POD, "-c", "host", "--"];
const onBox: BoxExec = (command, opts = {}) => kubectl([...EXEC_PREFIX.slice(1), "sh", "-c", command], opts);

// ── kubectl ──

function kubectl(args: string[], opts: { input?: string; allowFailure?: boolean; timeoutMs?: number } = {}): Result {
  const res = spawnSync("kubectl", args, {
    encoding: "utf-8",
    input: opts.input,
    timeout: opts.timeoutMs ?? 120_000,
  });
  if (res.error) throw res.error;
  const out = { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (!opts.allowFailure && out.code !== 0) {
    throw new Error(`kubectl ${args.join(" ")} exited ${out.code}: ${out.stderr.trim()}`);
  }
  return out;
}

/** `kubectl -n NAMESPACE get …`: the output, or null when it is NotFound. */
function get(args: string[]): string | null {
  const res = kubectl(["-n", NAMESPACE, "get", ...args], { allowFailure: true });
  if (res.code === 0) return res.stdout.trim();
  if (/NotFound|not found/.test(res.stderr)) return null;
  throw new Error(`kubectl get ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`);
}

function replicas(): string | null {
  return get(["statefulset", NAME, "-o", "jsonpath={.spec.replicas}"]);
}

/** The pod's uid, or null when there is none. */
function podUid(): string | null {
  return get(["pod", POD, "-o", "jsonpath={.metadata.uid}"]) || null;
}

/** The pod's uid once it is Ready, else null. */
function readyPodUid(): string | null {
  const out = get(["pod", POD, "-o", 'jsonpath={.metadata.uid} {.status.conditions[?(@.type=="Ready")].status}']);
  if (!out) return null;
  const [uid, ready] = out.split(" ");
  return ready === "True" ? uid : null;
}

/** Starts `script` with node in the pod, detached from the exec that started it. */
function startOnBox(file: string, script: string): void {
  onBox(`cat > "$HOME/${file}"`, { input: script });
  onBox(`setsid nohup node "$HOME/${file}" >/dev/null 2>&1 </dev/null &`);
}

describe.skipIf(SKIP !== null)("a recipe host on a real Kubernetes cluster", () => {
  let harness: RecipeHarness;
  let registry: BackendRegistry;
  let routing: HostRouting;
  let statuses: Array<HostStatusInfo["status"]>;
  let projectId: string;
  let workspacePath: string;
  let roomId: string | null;
  const recipeId = `kubernetes-${NAMESPACE}-${NAME}`.slice(0, 64);

  const provider = (): RecipeHostProvider => harness.provider();
  const server = (): HostServerClient => harness.server();
  const serverConnected = (): Promise<HostServerClient> => harness.serverConnected();
  const launchAgent = (workspace: string): Promise<string> => harness.launchAgent(workspace);
  const agentActive = (paneId: string): Promise<void> => harness.agentActive(paneId);

  beforeAll(() => {
    requireTarball();
    // The recipe, from the bundled template, as the Hosts page writes it —
    // under the worker's own $HOME (`setup-isolated-home.ts`). No context:
    // KUBECONFIG picks the cluster.
    createRecipeFromTemplate("kubernetes", { namespace: NAMESPACE, name: NAME, image: IMAGE, storage: "1Gi" });
    const up = path.join(recipeDir(recipeId), "up.sh");
    const script = fs.readFileSync(up, "utf-8");
    const marker = '            - name: MANOR_INSTANCE_ID\n              value: "$namespace/$name"\n';
    expect(script).toContain(marker);
    // A recipe is the user's to edit: this one keeps the box off the
    // production relay.
    fs.writeFileSync(
      up,
      script.replace(
        marker,
        () => `${marker}            - name: MANOR_RELAY_URL\n              value: ${CLOSED_RELAY_URL}\n`,
      ),
    );

    harness = createRecipeHarness({ hostId: HOST_ID, label: NAME, via: "kubectl" });
    ({ registry, routing, statuses } = harness);
  });

  afterAll(async () => {
    await registry?.disconnectAll();
    // For a look inside after a failure: `kubectl delete namespace` by hand.
    if (process.env.MANOR_E2E_K8S_KEEP === "1") return;
    kubectl(["delete", "namespace", NAMESPACE, "--ignore-not-found", "--wait=false"], { allowFailure: true });
  }, STEP_TIMEOUT_MS);

  it(
    "1. brings the kubernetes template up over kubectl exec, under supervise, adopted, with a workspace and an agent",
    async () => {
      registry.register(HOST_ID, { kind: "recipe", recipeId });
      expect(registry.list().find((h) => h.hostId === HOST_ID)).toMatchObject({
        providerKind: "recipe",
        capabilities: { canStop: true, canDestroy: true, autoSleep: false },
      });

      await registry.ensureConnected(HOST_ID);
      expect(registry.status(HOST_ID)).toBe("connected");
      expect(kubectl(["get", "namespace", NAMESPACE, "-o", "jsonpath={.status.phase}"]).stdout).toBe("Active");
      expect(get(["secret", `${NAME}-key`, "-o", "jsonpath={.type}"])).toBe("Opaque");
      expect(get(["statefulset", NAME, "-o", "jsonpath={.status.readyReplicas}"])).toBe("1");
      expect(onBox('"$HOME/.manor/bin/manor-host" --version').stdout.trim()).toBe(VERSION);
      // The claim is the home directory, owned by manor (fsGroup).
      expect(onBox('stat -c "%u" "$HOME/.manor"').stdout.trim()).toBe("1000");

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
    },
    STEP_TIMEOUT_MS,
  );

  it(
    "6. forwards a port to the pod over kubectl exec",
    async () => {
      startOnBox(
        "e2e-http.js",
        "require('http').createServer((q, s) => s.end('hello from the box')).listen(4567, '127.0.0.1')",
      );
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
      startOnBox(
        "e2e-half-close.js",
        "require('net').createServer({ allowHalfOpen: true }, (s) => { let d = ''; " +
          "s.on('data', (c) => (d += c)); s.on('end', () => s.end('got:' + d)); })" +
          ".listen(4568, '127.0.0.1')",
      );
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
        // Retried only until the server in the pod listens.
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
    "2. comes back by itself when the pod is deleted: reconnecting, never sleeping, and under supervise with no connect",
    async () => {
      expect(roomId).toBeTruthy();

      // Connected: the desktop rides the restart out by itself (C1).
      await serverConnected();
      const firstUid = podUid();
      expect(firstUid).toBeTruthy();
      const mark = statuses.length;
      kubectl(["-n", NAMESPACE, "delete", "pod", POD, "--wait=false"]);
      await pollFor(
        "the host dropping",
        () => (statuses.slice(mark).some((s) => s !== "connected") ? true : null),
        STEP_MS,
        200,
      );
      // Stops early on `sleeping`: the loop has given up by then.
      await pollFor(
        "the host back, or asleep",
        () => {
          const now = registry.status(HOST_ID);
          return now === "connected" || statuses.slice(mark).includes("sleeping") ? now : null;
        },
        STEP_MS * 3,
        500,
      );
      expect(statuses.slice(mark), "the host went to sleeping while the pod restarted").not.toContain("sleeping");
      expect(registry.status(HOST_ID)).toBe("connected");
      expect(podUid()).not.toBe(firstUid);
      const client = await serverConnected();
      expect((await client.api.hostServer.status()).relay.roomId).toBe(roomId);

      // Disconnected: whatever runs after the restart, nothing here started it.
      await registry.disconnect(HOST_ID);
      const secondUid = podUid();
      kubectl(["-n", NAMESPACE, "delete", "pod", POD, "--wait=false"]);
      await pollFor(
        "a new pod, ready",
        () => {
          const uid = readyPodUid();
          return uid && uid !== secondUid ? uid : null;
        },
        STEP_MS * 3,
        1_000,
      );
      const pid = await pollFor("the host server in the new pod", () => serverPid(onBox), STEP_MS, 1_000);
      expect(parentCommand(onBox, pid)).toContain("supervise");
      expect(registry.status(HOST_ID)).toBe("disconnected");

      const backend = onBox('cat "$HOME/.manor/remote/server/secret-backend"').stdout;
      expect(JSON.parse(backend)).toEqual({ backend: "key-file" });
      // The key is mounted from the Secret, not on the claim.
      onBox('test "$MANOR_SECRET_KEY_FILE" = /run/secrets/manor-key && test -s "$MANOR_SECRET_KEY_FILE"');

      const fresh = await freshServerClient(EXEC_PREFIX, NAME);
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
    STEP_TIMEOUT_MS * 4,
  );

  it(
    "3. stops into sleeping with no reconnects, and a routed write wakes it",
    async () => {
      await registry.stop(HOST_ID);
      expect(registry.status(HOST_ID)).toBe("sleeping");
      expect(replicas()).toBe("0");
      await pollFor("the pod gone", () => (podUid() === null ? true : null), STEP_MS * 2, 1_000);

      const mark = statuses.length;
      await new Promise((r) => setTimeout(r, 10_000));
      expect(statuses.slice(mark).filter((s) => s !== "sleeping")).toEqual([]);
      expect(registry.status(HOST_ID)).toBe("sleeping");
      expect(podUid()).toBeNull();

      const result = (await routing.invoke(
        HOST_ID,
        "projects",
        "createWorktree",
        [projectId, "woken"],
        CALLER,
      )) as { workspaces: Array<{ path: string }> } | null;
      expect(registry.status(HOST_ID)).toBe("connected");
      expect(replicas()).toBe("1");
      const woken = result?.workspaces.find((w) => w.path.endsWith("woken"));
      expect(woken, JSON.stringify(result?.workspaces)).toBeTruthy();
      onBox(`test -d '${woken!.path}'`);
    },
    STEP_TIMEOUT_MS * 3,
  );

  it(
    "7. removes the host with destroy: StatefulSet, claim and Secret gone, host unlisted",
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
      expect(get(["statefulset", NAME])).toBeNull();
      expect(get(["pvc", `home-${NAME}-0`])).toBeNull();
      expect(get(["secret", `${NAME}-key`])).toBeNull();
      expect(fs.existsSync(path.join(hostRecipesDir(), recipeId))).toBe(false);
    },
    STEP_TIMEOUT_MS * 2,
  );
});
