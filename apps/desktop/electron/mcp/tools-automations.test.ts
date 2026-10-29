import { describe, it, expect } from "vitest";

import { commandTable, runCli, type CliIo } from "./cli";
import { automationsModule } from "./tools-automations";
import type { Http } from "./types";

type Call = { method: string; path: string; body?: Record<string, unknown> };

function fakeHttp(answer: unknown = {}): Http & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    get: async (path) => {
      calls.push({ method: "GET", path });
      if (path.startsWith("/context")) return { projectId: "p-context", workspacePath: "/ws" };
      return answer;
    },
    post: async (path, body) => {
      calls.push({ method: "POST", path, body });
      return answer;
    },
    del: async (path, body) => {
      calls.push({ method: "DELETE", path, body });
      return answer;
    },
  };
}

const VIEW = {
  id: "a1",
  name: "Nightly triage",
  enabled: false,
  schedule: { cron: "0 9 * * *", timezone: "UTC" },
  projectId: "p1",
  prompt: "Triage",
  agentKind: "claude",
  workspace: { mode: "new" },
  missedGraceMinutes: 720,
  nextRunAt: null,
  nextRuns: [],
  lastRun: null,
  hostId: "local",
};

const handlers = automationsModule.handlers;

describe("automation tools", () => {
  it("are the CLI's commands", () => {
    const commands = [...commandTable().keys()].filter((c) => c.includes("automation"));
    expect(commands).toEqual([
      "list-automations",
      "get-automation",
      "create-automation",
      "update-automation",
      "pause-automation",
      "resume-automation",
      "run-automation",
      "list-automation-runs",
      "delete-automation",
    ]);
  });

  it("create defaults the project, timezone, agent and workspace, and starts paused", async () => {
    const http = fakeHttp(VIEW);
    await handlers.create_automation({ name: "Nightly triage", cron: "0 9 * * *", prompt: "Triage" }, http);
    const post = http.calls.find((c) => c.method === "POST");
    expect(post).toEqual({
      method: "POST",
      path: "/automations",
      body: {
        name: "Nightly triage",
        prompt: "Triage",
        projectId: "p-context",
        agentKind: "claude",
        workspace: { mode: "new" },
        schedule: { cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      },
    });
  });

  it("create takes a reused workspace and a host", async () => {
    const http = fakeHttp(VIEW);
    await handlers.create_automation(
      {
        name: "n",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        projectId: "p1",
        workspacePath: "/p1/ws",
        enabled: true,
        hostId: "box-1",
      },
      http,
    );
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].body).toMatchObject({
      projectId: "p1",
      enabled: true,
      workspace: { mode: "reuse", workspacePath: "/p1/ws" },
      hostId: "box-1",
    });
  });

  it("update sends only the fields given; a cron alone keeps the timezone", async () => {
    const http = fakeHttp(VIEW);
    await handlers.update_automation({ id: "a1", cron: "30 7 * * *", keepLast: 3 }, http);
    expect(http.calls).toEqual([
      {
        method: "POST",
        path: "/automations/a1/update",
        body: { schedule: { cron: "30 7 * * *" }, workspace: { keepLast: 3 } },
      },
    ]);
  });

  it("update names a workspace mode only when given, and a keepLast of 0 drops it", async () => {
    const http = fakeHttp(VIEW);
    await handlers.update_automation({ id: "a1", workspacePath: "/p1/other" }, http);
    await handlers.update_automation({ id: "a1", workspace: "new" }, http);
    await handlers.update_automation({ id: "a1", keepLast: 0 }, http);
    expect(http.calls.map((c) => c.body)).toEqual([
      { workspace: { workspacePath: "/p1/other" } },
      { workspace: { mode: "new" } },
      { workspace: { keepLast: null } },
    ]);
  });

  it("create says when the timezone is this machine's default", async () => {
    const http = fakeHttp(VIEW);
    const defaulted = await handlers.create_automation({ name: "N", cron: "0 9 * * *", prompt: "P" }, http);
    const named = await handlers.create_automation(
      { name: "N", cron: "0 9 * * *", prompt: "P", timezone: "UTC" },
      http,
    );
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0].text;
    expect(textOf(defaulted)).toContain("0 9 * * * (UTC)");
    expect(textOf(defaulted)).toContain("Timezone UTC is the default");
    expect(textOf(named)).not.toContain("is the default");
  });

  it("maps pause, resume, run, runs, get, list and delete to their routes", async () => {
    const http = fakeHttp(VIEW);
    await handlers.pause_automation({ id: "a1" }, http);
    await handlers.resume_automation({ id: "a1", hostId: "box-1" }, http);
    const ran = fakeHttp({ firedAt: "2026-10-29T09:00:00.000Z", trigger: "manual", outcome: "failed", detail: "The project isn't set up on this host" });
    const runText = await handlers.run_automation({ id: "a1" }, ran);
    await handlers.delete_automation({ id: "a1", hostId: "box-1" }, http);
    const reads = fakeHttp([]);
    await handlers.list_automations({ hostId: "box-1" }, reads);
    await handlers.list_automation_runs({ id: "a 1" }, reads);
    expect(http.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["POST", "/automations/a1/update", { enabled: false }],
      ["POST", "/automations/a1/update", { enabled: true, hostId: "box-1" }],
      ["DELETE", "/automations/a1", { hostId: "box-1" }],
    ]);
    expect(ran.calls).toEqual([{ method: "POST", path: "/automations/a1/run", body: {} }]);
    expect(runText.content[0].text).toContain("failed: The project isn't set up on this host");
    expect(reads.calls.map((c) => c.path)).toEqual(["/automations?hostId=box-1", "/automations/a%201/runs"]);
  });

  it("are listed in manor --help", async () => {
    const out: string[] = [];
    const io: CliIo = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} } };
    await runCli(["--help"], fakeHttp(), io);
    const help = out.join("");
    expect(help).toContain("automations:");
    expect(help).toMatch(/create-automation\s+Create an automation that starts an agent/);
  });
});
