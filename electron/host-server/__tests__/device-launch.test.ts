/**
 * The host owns its host: with the owner gone, a phone
 * makes a worktree in a project on the box and launches an agent in it. The
 * session starts on the server — nobody is looking at the pane — and the
 * agent is recorded under the project and workspace the server's own
 * projects and layout say it is in. See `harness.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, ptySubprocess, useHostServerHarness, withGit } from "./harness";
import type { AgentInfo } from "../../agent-persistence";
import type { ProjectInfo } from "../../projects/types";
import type { LayoutEntry } from "../../../src/lib/layout/protocol";
import type { PairResult } from "../../remote-control/relay-room";
import { createTab } from "../../../src/lib/layout/ids";

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

describe("a device on a host server that owns its host", () => {
  const h = useHostServerHarness();

  it("creates a worktree and launches an agent there with no owner connected", async () => {
    await withGit();
    const repo = path.join(h.tmp, "repo");
    await seedRepo(repo);
    h.adopt();
    const server = await h.serve();
    await h.relayUp(server);

    // The owner sets the project up — the one thing a device may not — and
    // pairs a phone. Then it goes.
    const owner = await h.owner();
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    expect(project).toMatchObject({ name: "demo", path: repo, hostId: "local" });
    await owner.invoke("projects", "update", project.id, {
      worktreePath: path.join(h.tmp, "worktrees"),
    });
    const paired = await owner.invoke<PairResult>("remoteControl", "pair", "phone");
    owner.client.dispose();

    const p = await h.phone(paired.pairingUrl);
    const listed = await p.call("projects", "getAll");
    expect((listed.result as ProjectInfo[]).map((x) => x.id)).toEqual([project.id]);

    // A worktree, made by the box's own git.
    const created = await p.call("projects", "createWorktree", project.id, "feature");
    expect(created).toMatchObject({ ok: true });
    const workspace = (created.result as ProjectInfo).workspaces.find(
      (ws) => ws.path !== repo,
    );
    expect(workspace?.path).toBe(path.join(h.tmp, "worktrees", "feature"));
    const wsPath = workspace!.path;
    expect(fs.existsSync(path.join(wsPath, "README.md"))).toBe(true);

    // An agent tab: its launch line waits on the server, and the tab's
    // apply starts the session there, with no viewer.
    const paneId = "pane-agent";
    expect(
      await p.call("layout", "setPendingCommand", paneId, "claude", "agent-startup"),
    ).toMatchObject({ ok: true });
    expect(
      await p.call("layout", "apply", wsPath, {
        type: "new-tab",
        tab: createTab(undefined, paneId),
      }),
    ).toMatchObject({ ok: true });
    const session = await eventually(
      () => h.daemon.getHost().listSessions().find((s) => s.sessionId === paneId),
      Boolean,
      "the agent's session on the daemon",
    );
    expect(session?.cwd).toBe(wsPath);

    // Its launch line waits for the shell's first output, and is typed then.
    const shell = ptySubprocess();
    expect(shell.typed()).toBe("");
    shell.output("$ ");
    await eventually(
      () => shell.typed(),
      (typed) => typed.includes("claude"),
      "the launch line typed into the shell",
    );

    // The layout is the server's, and persisted.
    const layout = await p.call("layout", "getAll");
    const entry = (layout.result as Record<string, LayoutEntry>)[wsPath];
    expect(Object.keys(entry.paneSessions)).toContain(paneId);
    await eventually(
      () => fs.existsSync(h.paths.layout) && fs.readFileSync(h.paths.layout, "utf-8"),
      (raw) => typeof raw === "string" && raw.includes(paneId),
      "the layout on disk",
    );

    // The agent's hooks: recorded under the project and workspace the
    // server's own state places the pane in, not a renderer's word.
    for (const eventType of ["SessionStart", "UserPromptSubmit"]) {
      h.daemon.emitHook({ paneId, eventType, kind: "claude", sessionId: "sess-launched" });
    }
    const agents = await eventually(
      async () => (await p.call("agents", "getAll")).result as AgentInfo[],
      (list) => list.some((a) => a.paneId === paneId),
      "the launched agent",
    );
    expect(agents.find((a) => a.paneId === paneId)).toMatchObject({
      projectId: project.id,
      projectName: "demo",
      workspacePath: wsPath,
      hostId: "local",
    });

    // The phone mounts the pane: it attaches to the launched session, and
    // owns its winsize — the only other client on it is this server.
    const mounted = await p.call("pty", "create", paneId, wsPath, 100, 30);
    expect(mounted).toMatchObject({
      ok: true,
      result: { ok: true, prewarmed: true, winsizeOwner: true },
    });
  });
});
