/**
 * The desktop's side of the recipe-host E2E suites, shared by
 * the Docker and Kubernetes suites: the real `BackendRegistry` with a real
 * `RecipeHostProvider`, a `HostRouting`, and the helpers that drive a host
 * server through them. Everything that touches the box goes through a
 * `BoxExec`, so the suites differ only in how they reach it (`docker exec`,
 * `kubectl exec`).
 *
 * No `describe` or `it` here: vitest only collects the `*.test.ts` files that
 * import it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { expect } from "vitest";

import type { Caller } from "../../bridge/method";
import { HostRouting } from "../../server/host-routing";
import { HostServerClient } from "../host-server-client";
import { CommandHostProvider } from "../providers/command-provider";
import { RecipeHostProvider } from "../providers/recipe-provider";
import { BackendRegistry, type HostStatusInfo } from "../registry";
import { ensureRemoteHost, hostTarballPath } from "../remote-bootstrap";
import type { HostSpec, WorkspaceBackend } from "../types";
import type { EnsureRemoteHost } from "../../terminal-host/bridge-spawner";
import { pollFor } from "../../../tests/e2e/helpers/remote-host";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const VERSION = (
  JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version: string }
).version;
export const TARBALL = hostTarballPath(VERSION, path.join(ROOT, "dist-electron"));
export const STUB_DIR = path.join(ROOT, "tests", "e2e", "remote-host");
/** What the box's host server dials: never the production relay. */
export const CLOSED_RELAY_URL = "http://127.0.0.1:9";
export const REMOTE_AGENT = "~/.manor-e2e/bin/manor-e2e-agent";

/** node-pty compiles from source during the first bootstrap. */
export const BOOTSTRAP_TIMEOUT_MS = 15 * 60_000;
export const STEP_TIMEOUT_MS = 90_000;
export const STEP_MS = 60_000;

export const CALLER: Caller = { id: "recipe-e2e", callerClass: "local" };

export interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `command` on the box as `manor`, through `sh -c`. */
export type BoxExec = (command: string, opts?: { input?: string; allowFailure?: boolean }) => Result;

/** Fail with a pointer to the build step when the host tarball isn't there. */
export function requireTarball(): void {
  if (!fs.existsSync(TARBALL)) {
    throw new Error(
      `${TARBALL} is missing — run \`pnpm build && node scripts/build-host-tarball.mjs\` ` +
        "(scripts/test-remote-e2e.mjs does both unless --no-build).",
    );
  }
}

/** Bootstrap from the built tarball; `via` is the exec program (`docker`, `kubectl`). */
export function tarballEnsureHost(via: string): EnsureRemoteHost {
  return async (target, version, exec) => {
    if (!version) return;
    await ensureRemoteHost(target, version, exec, {
      via,
      loadTarball: () => fs.readFileSync(TARBALL),
    });
  };
}

/** A local backend nothing here calls: the registry only listens to it. */
const LOCAL_STUB = { pty: { onEvent: () => () => {} } } as unknown as WorkspaceBackend;

export interface RecipeHarness {
  registry: BackendRegistry;
  routing: HostRouting;
  /** Every status `hostId` has been through, in order. */
  statuses: Array<HostStatusInfo["status"]>;
  provider(): RecipeHostProvider;
  server(): HostServerClient;
  serverConnected(): Promise<HostServerClient>;
  /** Launch the stub agent in `workspace` through the server's own route, as the CLI does. */
  launchAgent(workspace: string): Promise<string>;
  agentActive(paneId: string): Promise<void>;
}

/**
 * The registry and routing for the one recipe host `hostId`, whose recipe is
 * already on disk. `via` is the exec program the recipe's template uses.
 */
export function createRecipeHarness(opts: { hostId: string; label: string; via: string }): RecipeHarness {
  const { hostId } = opts;
  const ensureHost = tarballEnsureHost(opts.via);
  const statuses: Array<HostStatusInfo["status"]> = [];
  const registry = new BackendRegistry({
    local: LOCAL_STUB,
    remoteVersion: VERSION,
    createProvider: (id, spec: HostSpec, providerOpts) => {
      if (spec.kind !== "recipe") throw new Error("a recipe host only");
      return new RecipeHostProvider(id, spec.recipeId, {
        onBootstrapProgress: providerOpts.onBootstrapProgress,
        ensureRemoteHost: ensureHost,
      });
    },
    hostProxy: {
      bus: { publish: () => {} } as never,
      label: () => opts.label,
    },
    isAdopted: () => true,
  });
  registry.onStatusChange((hosts) => {
    const mine = hosts.find((h) => h.hostId === hostId);
    if (mine) statuses.push(mine.status);
  });
  const routing = new HostRouting({
    registry,
    isAdopted: () => true,
    hasLocalProject: () => false,
    pendingCommands: { peek: () => undefined, take: () => undefined } as never,
    decorateProject: (result) => result,
    bus: { publish: () => {}, publishTo: () => {} } as never,
    handOver: async () => {},
  });

  function provider(): RecipeHostProvider {
    const p = registry.provider(hostId);
    if (!(p instanceof RecipeHostProvider)) throw new Error("the host has no recipe provider");
    return p;
  }

  function server(): HostServerClient {
    const client = registry.hostServer(hostId);
    if (!client) throw new Error("the host has no owner channel");
    return client;
  }

  async function serverConnected(): Promise<HostServerClient> {
    const client = server();
    await pollFor("the owner channel", () => (client.state === "connected" ? true : null), STEP_MS);
    return client;
  }

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

  return { registry, routing, statuses, provider, server, serverConnected, launchAgent, agentActive };
}

/** The host server's pid when it runs and its socket is there, else null. */
export function serverPid(exec: BoxExec): number | null {
  const res = exec(
    'p=$(cat "$HOME/.manor/remote/server/server.pid" 2>/dev/null) && kill -0 "$p" 2>/dev/null && ' +
      'test -S "$HOME/.manor/remote/server/server.sock" && echo "$p"',
    { allowFailure: true },
  );
  const pid = Number(res.stdout.trim());
  return res.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** The command line of `pid`'s parent, on the box. */
export function parentCommand(exec: BoxExec, pid: number): string {
  return exec(`ps -o args= -p "$(ps -o ppid= -p ${pid} | tr -d ' ')"`, { allowFailure: true }).stdout.trim();
}

/**
 * An owner channel of its own to the box at `execPrefix` (an exec argv that
 * ends where a command goes, e.g. `docker exec -i -u manor <name>`), as a
 * fresh desktop dials it.
 */
export async function freshServerClient(
  execPrefix: string[],
  label: string,
): Promise<{
  client: HostServerClient;
  dispose: () => Promise<void>;
}> {
  const provider = new CommandHostProvider(execPrefix, {
    label,
    ensureRemoteHost: tarballEnsureHost(execPrefix[0]),
  });
  const client = new HostServerClient({
    hostId: `${label}-fresh`,
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

/**
 * The body of scenario 1 after adoption: the agent and hook stubs, a git
 * project on the box (with a bare origin for the worktree's fetch), a
 * workspace in it, and the on-busy hook scenario 5 checks.
 */
export async function seedProjectAndWorkspace(
  exec: BoxExec,
  client: HostServerClient,
  home = "/home/manor",
): Promise<{ projectId: string; projectPath: string; workspacePath: string }> {
  const stubs = ["manor-e2e-agent", "fire-hook"];
  exec('mkdir -p "$HOME/.manor-e2e/bin"');
  for (const stub of stubs) {
    exec(`cat > "$HOME/.manor-e2e/bin/${stub}" && chmod 755 "$HOME/.manor-e2e/bin/${stub}"`, {
      input: fs.readFileSync(path.join(STUB_DIR, stub), "utf-8"),
    });
  }
  exec(
    [
      "set -e",
      "git config --global user.email e2e@manor.local",
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
  const projectPath = `${home}/proj`;
  const project = await client.api.projects.add("proj", projectPath);
  const projectId = project.id;
  const withWorkspace = await client.api.projects.createWorktree(projectId, "e2e-one");
  const workspacePath =
    withWorkspace?.workspaces.find((w) => w.path !== projectPath)?.path ??
    (() => {
      throw new Error(`no worktree in ${JSON.stringify(withWorkspace?.workspaces)}`);
    })();
  exec(`test -d '${workspacePath}'`);

  // The box hook scenario 5 checks: the template wrote a no-op on-busy.
  exec('test -x "$HOME/.manor/remote/hooks/on-busy"');
  exec('printf \'#!/bin/sh\\ntouch "$HOME/busy-hook-ran"\\n\' > "$HOME/.manor/remote/hooks/on-busy"');
  return { projectId, projectPath, workspacePath };
}
