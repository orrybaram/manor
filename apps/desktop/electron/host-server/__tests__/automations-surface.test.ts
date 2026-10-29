/**
 * A host server's automations through each surface: the box's `manor` CLI
 * with no desktop connected (list, create, pause, resume, run now, runs,
 * delete), and the bridge's `automations.*` with its caller rules — a
 * device reads, runs and pauses; making, changing and deleting are the
 * owner's; nothing is written before adoption. See `harness.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, useHostServerHarness, withGit, withoutGit } from "./harness";
import { runCli, type CliIo } from "../../mcp/cli";
import { createHttp } from "../../mcp/http-client";
import type { ProjectInfo } from "../../projects/types";
import type { PairResult } from "../../remote-control/relay-room";
import type { AutomationView } from "../../../src/lib/automation-views";

async function seedRepo(dir: string): Promise<void> {
  const { execFileSync } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const origin = `${dir}-origin.git`;
  fs.mkdirSync(dir, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
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

const INPUT = {
  name: "Nightly triage",
  schedule: { cron: "0 9 * * 1-5", timezone: "UTC" },
  projectId: "p1",
  prompt: "Triage new issues",
  agentKind: "claude",
  workspace: { mode: "new" },
};

describe("a host server's automations", () => {
  const h = useHostServerHarness();
  const savedPortFile = process.env.MANOR_CONTROL_PORT_FILE;

  afterEach(() => {
    if (savedPortFile === undefined) delete process.env.MANOR_CONTROL_PORT_FILE;
    else process.env.MANOR_CONTROL_PORT_FILE = savedPortFile;
  });

  it("the box's CLI lists, creates, pauses, resumes, runs, shows runs and deletes them", async () => {
    await withGit();
    const repo = path.join(h.tmp, "repo");
    await seedRepo(repo);
    h.adopt();
    await h.serve();
    const portFile = path.join(h.tmp, "control-port");
    await h.daemon.startControlListener(portFile);
    process.env.MANOR_CONTROL_PORT_FILE = portFile;

    const owner = await h.owner();
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    await owner.invoke("projects", "update", project.id, { worktreePath: path.join(h.tmp, "worktrees") });
    owner.client.dispose();

    const empty = await eventually(() => manor("list-automations"), (r) => r.code === 0, "the CLI reaches the host server");
    expect(empty.out).toContain("No automations.");

    const created = await manor(
      "create-automation",
      "--name",
      "Nightly triage",
      "--cron",
      "0 9 * * 1-5",
      "--timezone",
      "UTC",
      "--project-id",
      project.id,
      "--prompt",
      "Triage new issues",
    );
    expect(created.err).toBe("");
    expect(created.code).toBe(0);
    const id = /\[([0-9a-f-]{36})\]/.exec(created.out)?.[1];
    expect(id).toBeDefined();
    expect(created.out).toContain("paused");

    const listed = await manor("list-automations");
    expect(listed.out).toContain("Nightly triage");
    expect(listed.out).toContain("0 9 * * 1-5 (UTC), paused");

    const resumed = await manor("resume-automation", "--id", id!);
    expect(resumed.out).toMatch(/^Resumed Nightly triage .* next run \d{4}-/);
    const paused = await manor("pause-automation", "--id", id!);
    expect(paused.out).toContain("Paused Nightly triage");

    const ran = await manor("run-automation", "--id", id!);
    expect(ran.err).toBe("");
    expect(ran.out).toMatch(/manual {2}started, agent /);
    expect(ran.out).toContain(path.join(h.tmp, "worktrees"));

    const runs = await manor("list-automation-runs", "--id", id!);
    expect(runs.out.trim().split("\n")).toHaveLength(1);
    expect(runs.out).toContain("manual  started");

    const shown = await manor("get-automation", "--id", id!);
    expect(shown.out).toContain("Next runs: ");
    expect(shown.out).toContain("Runs (1, newest first):");

    const bad = await manor(
      "create-automation",
      "--name",
      "x",
      "--cron",
      "every day",
      "--project-id",
      project.id,
      "--prompt",
      "y",
    );
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("HTTP 400");
    expect(bad.err).toContain("5 fields");

    const deleted = await manor("delete-automation", "--id", id!);
    expect(deleted.code).toBe(0);
    expect((await manor("list-automations")).out).toContain("No automations.");
  }, 30_000);

  it("lets a device read, run and pause them, and leaves the rest to the owner", async () => {
    withoutGit();
    h.adopt();
    const server = await h.serve();
    await h.relayUp(server);
    const owner = await h.owner();
    owner.subscribe("automations", "changed");
    const repo = path.join(h.tmp, "repo");
    fs.mkdirSync(repo, { recursive: true });
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    const created = await owner.invoke<AutomationView>("automations", "create", null, {
      ...INPUT,
      projectId: project.id,
    });
    expect(created).toMatchObject({ hostId: "local", enabled: false });
    await owner.waitFor(
      (f) => f.kind === "event" && f.ns === "automations" && f.event === "changed",
    );

    const paired = await owner.invoke<PairResult>("remoteControl", "pair", "phone");
    const p = await h.phone(paired.pairingUrl);
    const listed = await p.call("automations", "list", null);
    expect(listed).toMatchObject({ ok: true });
    expect((listed.result as AutomationView[]).map((a) => a.id)).toEqual([created.id]);
    expect(await p.call("automations", "setEnabled", null, created.id, true)).toMatchObject({
      ok: true,
      result: { enabled: true },
    });
    for (const [methodName, ...args] of [
      ["create", null, { ...INPUT, projectId: project.id }],
      ["update", null, created.id, { name: "Renamed" }],
      ["remove", null, created.id],
    ] as const) {
      expect(await p.call("automations", methodName, ...args)).toMatchObject({
        ok: false,
        code: "unavailable:host",
      });
    }
    expect(await owner.invoke<boolean>("automations", "remove", null, created.id)).toBe(true);
  });

  it("refuses every write before adoption", async () => {
    await h.serve();
    const owner = await h.owner();
    await expect(
      owner.invoke("automations", "create", null, INPUT),
    ).rejects.toMatchObject({ message: expect.stringMatching(/This host is being set up/) });
    await expect(owner.invoke("automations", "runNow", null, "a1")).rejects.toMatchObject({
      message: expect.stringMatching(/This host is being set up/),
    });
  });
});
