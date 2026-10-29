/**
 * `/automations` over a real store and scheduler, with a fake `fire`: the
 * views (next runs, the last run with its Agent's status), every write, the
 * 400s the CLI shows, and a request for an adopted host sent to its server.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AutomationStore } from "../automations/automation-store";
import { AutomationScheduler } from "../automations/scheduler";
import { createAutomation, type AutomationDeps } from "../automations/operations";
import { handleServerControlRequest } from "./server-routes";
import type { ServerRouteDeps } from "./types";
import type { AgentInfo } from "../agent-persistence";
import type { ProjectInfo } from "../persistence";
import type { AutomationDetail, AutomationRunView, AutomationView } from "../../src/lib/automation-views";

function project(id: string, hostId: string): ProjectInfo {
  return { id, name: id, path: `/${id}`, hostId, workspaces: [], folders: [] } as unknown as ProjectInfo;
}

describe("/automations", () => {
  let tmp: string;
  let store: AutomationStore;
  let deps: ServerRouteDeps;
  let agents: AgentInfo[];
  let paneStatus: Map<string, string>;
  let control: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manor-automation-routes-"));
    store = new AutomationStore(tmp);
    agents = [];
    paneStatus = new Map();
    const scheduler = new AutomationScheduler({
      store,
      now: Date.now,
      fire: async () => ({ outcome: "started", paneId: "pane-run", workspacePath: "/p1/ws" }),
      isAgentBusy: () => false,
    });
    control = vi.fn(async () => ({ status: 200, body: [{ id: "remote-1", hostId: "local" }] }));
    deps = {
      automations: { store, scheduler },
      agentManager: {
        getAgentById: (id: string) => agents.find((a) => a.id === id) ?? null,
        getAllAgents: () => agents,
      },
      agentStatus: {
        getPaneState: (paneId: string) =>
          paneStatus.has(paneId) ? { status: paneStatus.get(paneId) } : undefined,
      },
      projectManager: {
        getProjects: async () => [project("p1", "local"), project("p-box", "box-1"), project("p-old", "old-box")],
        hostLabel: (hostId: string) => (hostId === "local" ? "this Mac" : `me@${hostId}`),
        decorateRemoteResult: (p: unknown) => p,
      },
      hostRouting: {
        proxy: (hostId: string) => (hostId === "box-1" ? {} : null),
        control,
      },
    } as unknown as ServerRouteDeps;
  });

  afterEach(() => {
    store.flushNow();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function request(
    method: string,
    pathname: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; body: unknown }> {
    let out: { status: number; body: unknown } | null = null;
    const handled = await handleServerControlRequest(
      deps,
      method,
      new URL(pathname, "http://manor"),
      (status, answer) => {
        out ??= { status, body: answer };
      },
      async () => body,
    );
    expect(handled).toBe(true);
    return out!;
  }

  const input = {
    name: "Nightly triage",
    schedule: { cron: "0 9 * * 1-5", timezone: "Europe/London" },
    projectId: "p1",
    prompt: "Triage new issues",
    agentKind: "claude",
    workspace: { mode: "new" },
  };

  it("creates, lists, pauses, resumes, runs, lists runs and deletes", async () => {
    const created = await request("POST", "/automations", input);
    expect(created.status).toBe(200);
    const automation = created.body as AutomationView;
    expect(automation).toMatchObject({ name: "Nightly triage", enabled: false, hostId: "local", lastRun: null });
    expect(automation.nextRuns).toHaveLength(3);

    const listed = await request("GET", "/automations");
    expect((listed.body as AutomationView[]).map((a) => a.id)).toEqual([automation.id]);

    const resumed = await request("POST", `/automations/${automation.id}/update`, { enabled: true });
    expect(resumed.body).toMatchObject({ enabled: true });
    expect((resumed.body as AutomationView).nextRunAt).toBe((resumed.body as AutomationView).nextRuns[0]);

    // A schedule patch may name its cron alone; the timezone is kept.
    const rescheduled = await request("POST", `/automations/${automation.id}/update`, {
      schedule: { cron: "30 7 * * *" },
    });
    expect((rescheduled.body as AutomationView).schedule).toEqual({ cron: "30 7 * * *", timezone: "Europe/London" });

    const paused = await request("POST", `/automations/${automation.id}/update`, { enabled: false });
    expect(paused.body).toMatchObject({ enabled: false, nextRunAt: null });

    const ran = await request("POST", `/automations/${automation.id}/run`);
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ outcome: "started", trigger: "manual", paneId: "pane-run", status: null });

    // The run's status is its Agent's, read when asked.
    const firedAt = (ran.body as AutomationRunView).firedAt;
    agents.push({ id: "agent-9", paneId: "pane-run", createdAt: firedAt, status: "active", lastAgentStatus: "thinking" } as AgentInfo);
    paneStatus.set("pane-run", "working");
    const runs = await request("GET", `/automations/${automation.id}/runs`);
    expect(runs.body).toEqual([expect.objectContaining({ agentId: "agent-9", status: "working" })]);

    const detail = (await request("GET", `/automations/${automation.id}`)).body as AutomationDetail;
    expect(detail.runs).toHaveLength(1);
    expect(detail.lastRun).toMatchObject({ agentId: "agent-9", status: "working" });

    const deleted = await request("DELETE", `/automations/${automation.id}`);
    expect(deleted).toEqual({ status: 200, body: { ok: true } });
    expect((await request("GET", "/automations")).body).toEqual([]);
    expect((await request("GET", `/automations/${automation.id}`)).status).toBe(404);
  });

  it("answers 400 with the validation message", async () => {
    const badCron = await request("POST", "/automations", { ...input, schedule: { cron: "every day", timezone: "UTC" } });
    expect(badCron.status).toBe(400);
    expect((badCron.body as { error: string }).error).toMatch(/5 fields/);

    const noProject = await request("POST", "/automations", { ...input, projectId: "nope" });
    expect(noProject).toEqual({ status: 400, body: { error: "Project not found: nope" } });

    const created = (await request("POST", "/automations", input)).body as AutomationView;
    const badTz = await request("POST", `/automations/${created.id}/update`, {
      schedule: { timezone: "Mars/Olympus" },
    });
    expect(badTz).toEqual({ status: 400, body: { error: "Unknown timezone: Mars/Olympus" } });
    expect((await request("POST", "/automations/missing/run")).status).toBe(404);
  });

  it("merges a workspace patch: a mode changes only when named, each field only in its own mode", async () => {
    const reuse = (await request("POST", "/automations", {
      ...input,
      workspace: { mode: "reuse", workspacePath: "/p1/ws" },
    })).body as AutomationView;
    const update = (patch: Record<string, unknown>) =>
      request("POST", `/automations/${reuse.id}/update`, { workspace: patch });

    expect(await update({ keepLast: 5 })).toEqual({
      status: 400,
      body: { error: "'keepLast' is only for a new workspace per run" },
    });
    expect(((await update({ workspacePath: "/p1/other" })).body as AutomationView).workspace).toEqual({
      mode: "reuse",
      workspacePath: "/p1/other",
    });
    expect(await update({ mode: "new", workspacePath: "/p1/ws" })).toEqual({
      status: 400,
      body: { error: "'workspacePath' is only for a reused workspace" },
    });
    expect(((await update({ mode: "new", keepLast: 3 })).body as AutomationView).workspace).toEqual({
      mode: "new",
      keepLast: 3,
    });
    // The new mode's keepLast stays through an edit that names only the mode,
    // and goes with a null.
    expect(((await update({ mode: "new" })).body as AutomationView).workspace).toEqual({ mode: "new", keepLast: 3 });
    expect(((await update({ keepLast: null })).body as AutomationView).workspace).toEqual({ mode: "new" });
    // Back to reuse needs a path again.
    expect(await update({ mode: "reuse" })).toEqual({ status: 400, body: { error: "Pick a workspace to reuse" } });
  });

  it("a bridge create for an adopted host's project, with no host named, says to make it there", async () => {
    const ops = deps as unknown as AutomationDeps;
    await expect(createAutomation(ops, { ...input, projectId: "p-box" })).rejects.toThrow(
      "This project is on me@box-1; create the automation there (hostId box-1)",
    );
    await expect(createAutomation(ops, { ...input, projectId: "p-old" })).rejects.toThrow(
      "me@old-box has no Manor host server yet, so it can't run automations",
    );
    expect(store.list()).toEqual([]);
  });

  it("sends a request for an adopted host to its server", async () => {
    const listed = await request("GET", "/automations?hostId=box-1");
    expect(control).toHaveBeenCalledWith("box-1", "GET", "/automations", {});
    expect(listed).toEqual({ status: 200, body: [{ id: "remote-1", hostId: "local" }] });

    // A create goes to its project's host, without the host named.
    await request("POST", "/automations", { ...input, projectId: "p-box" });
    expect(control).toHaveBeenLastCalledWith("box-1", "POST", "/automations", { ...input, projectId: "p-box" });

    await request("POST", "/automations/a1/update", { hostId: "box-1", enabled: true });
    expect(control).toHaveBeenLastCalledWith("box-1", "POST", "/automations/a1/update", { enabled: true });
    expect(store.list()).toEqual([]);
  });

  it("refuses a host with no host server", async () => {
    const listed = await request("GET", "/automations?hostId=old-box");
    expect(listed).toEqual({
      status: 400,
      body: { error: "me@old-box has no Manor host server yet, so it can't run automations" },
    });
    const created = await request("POST", "/automations", { ...input, projectId: "p-old" });
    expect(created.status).toBe(400);
    expect(control).not.toHaveBeenCalled();
  });
});
