/**
 * The box's `manor` CLI is answered by its host server (ADR-227 D8): with no
 * desktop connected, `manor create-workspace` and `manor list-workspaces`
 * reach the server through the daemon's control relay, and the workspace is
 * there for a phone paired to the same server. See `harness.ts`.
 *
 * Plus the relay's own rules: what the CLI may call, what needs Manor
 * desktop, and the refusal until the host is adopted.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, useHostServerHarness, withGit } from "./harness";

// The desktop's route table, checked against below, pulls in modules that
// import electron, which isn't there outside the app.
vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => {}) },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => "/tmp" },
  screen: {},
  webContents: { fromId: () => null },
  Notification: class {},
}));

vi.mock("electron-updater", () => ({
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
}));

import { runCli, type CliIo } from "../../mcp/cli";
import { createHttp } from "../../mcp/http-client";
import { routes } from "../../routes";
import { serverRoutes } from "../../routes/server-routes";
import type { ServerRouteDeps } from "../../routes/types";
import type { ProjectInfo } from "../../projects/types";
import type { PairResult } from "../../remote-control/relay-room";
import {
  DESKTOP_ONLY_PREFIXES,
  REMOTE_CONTROL_ALLOWLIST,
  answerCliRequest,
  isRemoteAllowed,
} from "../cli-relay";

/** A concrete path for a route pattern, every `:param` filled in. */
const sample = (p: string) => p.replace(/:[^/]+/g, "x1");

/** First path segments of a route table. */
const prefixes = (table: ReadonlyArray<{ path: string }>) =>
  new Set(table.map((r) => r.path.split("/")[1]));

/**
 * A repository with one commit on `main`, pushed to a bare `origin` beside
 * it (a new worktree branches from `origin/main`), by the real git.
 */
async function seedRepo(dir: string): Promise<void> {
  const { execFileSync } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const origin = `${dir}-origin.git`;
  fs.mkdirSync(dir, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  git(path.dirname(dir), "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  fs.writeFileSync(path.join(dir, "README.md"), "demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
}

/** The real CLI, as a terminal on the box runs it: through the relay's port file. */
async function manor(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
  };
  const code = await runCli(argv, createHttp(), io);
  return { code, out: out.join(""), err: err.join("") };
}

describe("the box's manor CLI, with no desktop connected (ADR-227 D8)", () => {
  const h = useHostServerHarness();
  const savedPortFile = process.env.MANOR_CONTROL_PORT_FILE;

  afterEach(() => {
    if (savedPortFile === undefined) delete process.env.MANOR_CONTROL_PORT_FILE;
    else process.env.MANOR_CONTROL_PORT_FILE = savedPortFile;
  });

  /** The daemon's relay listener, and this process's CLI pointed at it. */
  async function relayListener(): Promise<void> {
    const portFile = path.join(h.tmp, "control-port");
    await h.daemon.startControlListener(portFile);
    process.env.MANOR_CONTROL_PORT_FILE = portFile;
  }

  it("creates and lists a workspace, which a phone on the host server then sees", async () => {
    await withGit();
    const repo = path.join(h.tmp, "repo");
    await seedRepo(repo);
    h.adopt();
    const server = await h.serve();
    await h.relayUp(server);
    await relayListener();

    // The owner sets the project up and pairs a phone. Then it goes: from
    // here on no desktop is connected.
    const owner = await h.owner();
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    await owner.invoke("projects", "update", project.id, {
      worktreePath: path.join(h.tmp, "worktrees"),
    });
    const paired = await owner.invoke<PairResult>("remoteControl", "pair", "phone");
    owner.client.dispose();

    // The server asked the daemon for the CLI's requests on connect.
    const listed = await eventually(
      () => manor("list-projects"),
      (r) => r.code === 0,
      "the CLI reaches the host server",
    );
    expect(listed.out).toContain(project.id);

    const created = await manor(
      "create-workspace",
      "--project-id",
      project.id,
      "--name",
      "feature",
    );
    expect(created.err).toBe("");
    expect(created.code).toBe(0);
    const wsPath = path.join(h.tmp, "worktrees", "feature");
    expect(created.out).toContain(wsPath);
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true);

    const workspaces = await manor("list-workspaces", "--project-id", project.id);
    expect(workspaces.code).toBe(0);
    expect(workspaces.out).toContain(wsPath);

    // A phone paired to the same server sees it.
    const phone = await h.phone(paired.pairingUrl);
    const all = await phone.call("projects", "getAll");
    const [onPhone] = all.result as ProjectInfo[];
    expect(onPhone.workspaces.map((ws) => ws.path)).toContain(wsPath);
  });

  it("says a desktop-only route needs Manor desktop", async () => {
    h.adopt();
    await h.serve();
    await relayListener();
    const result = await eventually(
      () => manor("api", "GET", "/notifications"),
      (r) => r.err !== "" && !r.err.includes("503"),
      "the host server's answer",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("HTTP 403");
    expect(result.err).toContain("needs Manor desktop");
  });

  it("refuses everything until the desktop has handed the host over", async () => {
    await h.serve();
    await relayListener();
    const result = await eventually(
      () => manor("list-projects"),
      (r) => r.err.includes("being set up"),
      "the pending refusal",
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain("HTTP 503");
  });

  it("answers the owner's control requests over the owner channel", async () => {
    await withGit();
    const repo = path.join(h.tmp, "repo");
    await seedRepo(repo);
    h.adopt();
    await h.serve();
    const owner = await h.owner();
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    const answer = await owner.invoke<{ status: number; body: unknown }>(
      "hostServer",
      "control",
      "GET",
      `/projects/${project.id}/folders`,
      {},
    );
    expect(answer).toEqual({ status: 200, body: [] });
    // Not the CLI's allowlist: the owner may rename a workspace too.
    const renamed = await owner.invoke<{ status: number }>(
      "hostServer",
      "control",
      "POST",
      `/projects/${project.id}/workspaces/rename`,
      { workspacePath: repo, name: "Main" },
    );
    expect(renamed.status).toBe(200);
  });
});

describe("the CLI relay's rules", () => {
  it.each([
    ["GET", "/context"],
    ["GET", "/projects"],
    ["GET", "/projects/p1"],
    ["GET", "/projects/p1/branches"],
    ["GET", "/projects/p1/workspaces"],
    ["POST", "/projects/p1/workspaces"],
    ["DELETE", "/projects/p1/workspaces"],
    ["POST", "/projects/p1/workspaces/batch"],
    ["POST", "/projects/p1/workspaces/rename"],
    ["POST", "/projects/p1/workspaces/hidden"],
    ["POST", "/projects/p1/workspaces/reorder"],
    ["POST", "/projects/p1/workspaces/folder"],
    ["GET", "/projects/p1/folders"],
    ["POST", "/projects/p1/folders"],
    ["POST", "/projects/p1/folders/f1/rename"],
    ["POST", "/projects/p1/folders/f1/parent"],
    ["DELETE", "/projects/p1/folders/f1"],
    ["GET", "/projects/p1/issues"],
    ["POST", "/projects/p1/issues"],
    ["GET", "/projects/p1/issues/ENG-1"],
    ["GET", "/projects/p1/workspaces/issues"],
    ["POST", "/projects/p1/workspaces/issues"],
    ["DELETE", "/projects/p1/workspaces/issues"],
    ["GET", "/agents"],
    ["POST", "/agents"],
    ["GET", "//projects/p1/"],
  ])("allows %s %s", (method, p) => {
    expect(isRemoteAllowed(method, p)).toBe(true);
  });

  it.each([
    ["POST", "/projects"],
    ["DELETE", "/projects/p1"],
    ["POST", "/projects/p1/update"],
    ["POST", "/projects/reorder"],
    ["POST", "/projects/p1/workspaces/convert-main"],
    ["POST", "/sessions/send"],
    ["DELETE", "/agents/a1"],
    ["GET", "/panes"],
    ["GET", "/processes"],
    ["GET", "/projects/p1/issues/ENG-1/extra"],
    ["PUT", "/agents"],
  ])("refuses %s %s", (method, p) => {
    expect(isRemoteAllowed(method, p)).toBe(false);
  });

  it("allows only routes the host server has", () => {
    for (const entry of REMOTE_CONTROL_ALLOWLIST) {
      const matched = serverRoutes.some(
        (r) => r.method === entry.method && entry.pattern.test(sample(r.path)),
      );
      expect(matched, `${entry.method} ${entry.pattern}`).toBe(true);
    }
  });

  it("names every desktop-only prefix: the desktop's table less the server's, less git", () => {
    const server = prefixes(serverRoutes);
    const desktopOnly = [...prefixes(routes)].filter((p) => !server.has(p) && p !== "git");
    expect(new Set(desktopOnly)).toEqual(DESKTOP_ONLY_PREFIXES);
  });

  it("refuses off the allowlist without dispatching", async () => {
    const getProjects = vi.fn();
    const result = await answerCliRequest(
      {
        routes: { projectManager: { getProjects } } as unknown as ServerRouteDeps,
        ownership: { current: () => "host" },
      },
      { method: "DELETE", path: "/projects/p1?x=1", body: undefined },
    );
    expect(result).toEqual({
      status: 403,
      body: { error: "DELETE /projects/p1 isn't available from remote hosts" },
    });
    expect(getProjects).not.toHaveBeenCalled();
  });

  it("answers 400 for a path that is not a URL", async () => {
    const result = await answerCliRequest(
      {
        routes: {} as unknown as ServerRouteDeps,
        ownership: { current: () => "host" },
      },
      { method: "GET", path: "//[", body: undefined },
    );
    expect(result).toMatchObject({ status: 400 });
  });

  it("answers 500 when the route throws before answering", async () => {
    const result = await answerCliRequest(
      {
        routes: {
          projectManager: {
            getProjects: async () => {
              throw new Error("disk on fire");
            },
          },
        } as unknown as ServerRouteDeps,
        ownership: { current: () => "host" },
      },
      { method: "GET", path: "/context?cwd=/repo", body: undefined },
    );
    expect(result).toEqual({ status: 500, body: { error: "disk on fire" } });
  });
});
