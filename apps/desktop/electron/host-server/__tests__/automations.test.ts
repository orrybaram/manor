/**
 * Automations on a host server: one due when the server starts fires there,
 * with no owner connected — a workspace in the project's Automations folder
 * and an agent session in it — and nothing fires, or is used up, before
 * adoption or before the daemon is first reached.
 * See `harness.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, HarnessTransport, useHostServerHarness, withGit, withoutGit } from "./harness";
import type { ProjectInfo } from "../../projects/types";
import type { Automation, AutomationRun } from "../../../src/lib/automations";

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

/** An enabled every-minute automation whose last occurrence is due now. */
function writeDueAutomation(dataDir: string, projectId: string): Automation {
  const past = new Date(Date.now() - 90_000).toISOString();
  const automation: Automation = {
    id: "auto-1",
    name: "Nightly triage",
    enabled: true,
    schedule: { cron: "* * * * *", timezone: "UTC" },
    projectId,
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: 720,
    createdAt: past,
    updatedAt: past,
    lastScheduledFor: past,
    nextRunAt: null,
  };
  fs.writeFileSync(path.join(dataDir, "automations.json"), JSON.stringify({ automations: [automation] }));
  return automation;
}

function readRuns(dataDir: string): AutomationRun[] {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dataDir, "automation-runs.json"), "utf-8")) as {
      runs: AutomationRun[];
    }).runs;
  } catch {
    return [];
  }
}

/**
 * The runs the due occurrence fired. Every-minute and 90s behind, the
 * automation may also fold an earlier occurrence into a `missed` run, which
 * is on disk before the fire finishes.
 */
function firedRuns(dataDir: string): AutomationRun[] {
  return readRuns(dataDir).filter((r) => r.reason !== "missed");
}

describe("automations on a host server", () => {
  const h = useHostServerHarness();

  it("fires a due automation on start: a workspace in the Automations folder and an agent in it", async () => {
    await withGit();
    const repo = path.join(h.tmp, "repo");
    await seedRepo(repo);
    h.adopt();
    await h.serve();
    const owner = await h.owner();
    const project = await owner.invoke<ProjectInfo>("projects", "add", "demo", repo);
    const worktrees = path.join(h.tmp, "worktrees");
    await owner.invoke("projects", "update", project.id, { worktreePath: worktrees });
    owner.client.dispose();
    await h.stop();

    writeDueAutomation(h.paths.dataDir, project.id);
    await h.serve();

    const [run] = await eventually(
      () => firedRuns(h.paths.dataDir),
      (runs) => runs.length > 0,
      "the run on disk",
      15_000,
    );
    expect(run).toMatchObject({ automationId: "auto-1", outcome: "started", trigger: "schedule" });
    expect(run.workspacePath?.startsWith(worktrees)).toBe(true);
    const session = await eventually(
      () => h.daemon.getHost().listSessions().find((s) => s.sessionId === run.paneId),
      Boolean,
      "the agent's session on the daemon",
    );
    expect(session?.cwd).toBe(run.workspacePath);

    // The workspace is in the project's Automations folder.
    const projects = JSON.parse(fs.readFileSync(path.join(h.paths.dataDir, "projects.json"), "utf-8")) as {
      projects: Array<{ id: string; workspaceFolders?: Array<{ id: string; name: string }> }>;
    };
    const folders = projects.projects.find((p) => p.id === project.id)?.workspaceFolders ?? [];
    expect(folders.map((f) => f.name)).toEqual(["Automations"]);
  }, 30_000);

  it("fires nothing before the host is adopted, and leaves the occurrence for after", async () => {
    withoutGit();
    const automation = writeDueAutomation(h.paths.dataDir, "project-1");
    await h.serve();
    // A few ticks' worth: nothing recorded, the occurrence not used up.
    await new Promise((r) => setTimeout(r, 300));
    await h.stop();
    expect(readRuns(h.paths.dataDir)).toEqual([]);
    const saved = JSON.parse(fs.readFileSync(path.join(h.paths.dataDir, "automations.json"), "utf-8")) as {
      automations: Automation[];
    };
    expect(saved.automations[0].lastScheduledFor).toBe(automation.lastScheduledFor);
    expect(h.daemon.getHost().listSessions().map((s) => s.sessionId)).toEqual(["pane-1"]);

    // Adopted, it is still due and is judged as usual (the project isn't here).
    h.adopt();
    await h.serve();
    const [run] = await eventually(
      () => firedRuns(h.paths.dataDir),
      (runs) => runs.length > 0,
      "the run on disk",
    );
    expect(run).toMatchObject({ outcome: "failed", reason: "project-missing", trigger: "schedule" });
  });

  it("fires nothing until the daemon is first reached and caught up", async () => {
    withoutGit();
    h.adopt();
    writeDueAutomation(h.paths.dataDir, "project-1");
    let reach!: () => void;
    const reached = new Promise<void>((r) => (reach = r));
    const gated = new (class extends HarnessTransport {
      override async connectControl() {
        await reached;
        return super.connectControl();
      }
    })(h.daemon);
    const serving = h.serve({ transport: gated });
    await new Promise((r) => setTimeout(r, 300));
    expect(readRuns(h.paths.dataDir)).toEqual([]);

    reach();
    await serving;
    const [run] = await eventually(
      () => firedRuns(h.paths.dataDir),
      (runs) => runs.length > 0,
      "the run on disk",
    );
    expect(run).toMatchObject({ outcome: "failed", reason: "project-missing", trigger: "schedule" });
  });
});
