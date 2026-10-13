/**
 * Adoption (ADR-227 D3), end to end: a desktop's records for `box` handed to
 * box's host server over the owner channel (the real `HostServerClient`),
 * merged into the server's stores, and only then removed from the desktop.
 * See `harness.ts`, and `../../backend/__tests__/adoption-fixtures.ts` for
 * the desktop.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { eventually, hook, useHostServerHarness, withoutGit } from "./harness";
import type { AgentInfo } from "../../agent-persistence";
import type { PersistedLayout } from "../../terminal-host/layout-persistence";
import type { PersistedState } from "../../projects/types";
import type { ProjectInfo } from "../../projects/types";
import type { HostServerStatus } from "../relay";
import type { AdoptionBundle } from "../adopt";
import {
  BOX_APP,
  BOX_WT,
  agentRecord,
  defaultSeed,
  openDesktop,
  persistedWorkspace,
  readJson,
  seedDesktop,
} from "../../backend/__tests__/adoption-fixtures";

describe("adoption (ADR-227 D3)", () => {
  const h = useHostServerHarness();

  const desktopDir = (name = "desktop") => path.join(h.tmp, name);
  const hostProjects = () => readJson<PersistedState>(h.paths.projects).projects;
  const hostAgents = () =>
    readJson<{ agents: AgentInfo[] }>(path.join(h.paths.dataDir, "agents.json")).agents;
  const hostLayout = () => readJson<PersistedLayout>(h.paths.layout);
  const ids = (list: Array<{ id: string }>) => list.map((x) => x.id).sort();

  it("moves one host's projects, agents and layout onto its server, and only then off the desktop", async () => {
    withoutGit();
    seedDesktop(desktopDir());
    const desktop = openDesktop(desktopDir());
    const expectedProjects = desktop.projectManager.manifestRecords("box");
    const expectedBackupProjects = desktop.projectManager.hostProjectRecords("box").projects;

    await h.serve();
    const owner = await h.owner();
    owner.subscribe("projects", "changed");
    owner.subscribe("layout", "changed");

    const outcome = await desktop.adoption.run("box", owner.client);
    expect(outcome).toMatchObject({
      ownership: "pending",
      sent: true,
      removed: { projects: 2, agents: 2, workspaces: 2 },
    });

    // ── the host ──
    expect(
      await owner.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "host" });
    // Exactly the desktop's records: group settings resolved, no `hostPaths`,
    // `hostId` local (and so left out of the file).
    expect(hostProjects()).toEqual(
      expectedProjects.map(({ hostId: _hostId, ...record }) => record),
    );
    expect(hostProjects()[0]).toMatchObject({
      id: "box-app",
      name: "App",
      color: "red",
      workspaceNames: { [BOX_WT]: "Feature" },
      workspaceIssues: { [BOX_WT]: [expect.objectContaining({ identifier: "ENG-1" })] },
      workspaceFolders: [{ id: "f1", name: "Later", parentId: null }],
      workspaceFolderIds: { [BOX_WT]: "f1" },
      workspaceOrder: [BOX_APP, "f1", BOX_WT],
    });
    expect(hostProjects()[0]).not.toHaveProperty("hostPaths");
    const projects = await owner.invoke<ProjectInfo[]>("projects", "getAll");
    expect(ids(projects)).toEqual(["box-app", "box-other"]);

    expect(ids(hostAgents())).toEqual(["box-1", "box-2"]);
    expect(hostAgents().every((a) => a.hostId === "local")).toBe(true);
    expect(hostAgents().find((a) => a.id === "box-1")).toMatchObject({
      projectId: "box-app",
      workspacePath: BOX_WT,
      paneId: "pane-box",
    });

    const layout = hostLayout();
    expect(layout.workspaces.map((w) => w.workspacePath).sort()).toEqual([BOX_WT, BOX_APP].sort());
    expect(layout.lastActiveWorkspacePath).toBe(BOX_WT);
    const wt = layout.workspaces.find((w) => w.workspacePath === BOX_WT)!;
    expect(wt.panels["panel-1"].tabs[0].paneSessions).toEqual({
      "pane-box": { daemonSessionId: "pane-box", lastCwd: "/tmp", lastTitle: null },
    });

    // Whoever is connected hears it.
    await owner.waitFor((f) => f.kind === "event" && f.ns === "projects" && f.event === "changed");
    await owner.waitFor(
      (f) =>
        f.kind === "event" &&
        f.ns === "layout" &&
        f.event === "changed" &&
        (f.args as Array<{ workspacePath: string }>)[0].workspacePath === BOX_WT,
    );

    // ── the desktop ──
    const desktopState = readJson<PersistedState>(path.join(desktopDir(), "projects.json"));
    expect(ids(desktopState.projects)).toEqual(["local-app", "mac-app"]);
    // The group still names the adopted project: its id survives adoption.
    expect(desktopState.groups?.[0].memberIds).toEqual(["local-app", "box-app", "mac-app"]);
    expect(desktopState.groups?.[0].lastUsedHostId).toBe("box");
    expect(desktopState.hosts?.box).toMatchObject({
      adopted: true,
      adoptedProjectIds: ["box-app", "box-other"],
    });
    // The hook position the file was seeded with is gone: the box reads its own journal.
    expect(desktopState.hosts?.box).not.toHaveProperty("lastHookSeq");
    expect(desktopState.hosts?.mac).not.toHaveProperty("adopted");

    expect(ids(readJson<{ agents: AgentInfo[] }>(path.join(desktopDir(), "agents.json")).agents)).toEqual([
      "local-1",
      "mac-1",
    ]);
    const desktopLayout = readJson<PersistedLayout>(path.join(desktopDir(), "layout.json"));
    expect(desktopLayout.workspaces.map((w) => w.workspacePath)).toEqual([
      "/Users/me/app",
      "mac:/Users/me/mac-app",
    ]);
    expect(desktopLayout.lastActiveWorkspacePath).toBeNull();
    // Letting go ends nothing: the sessions carry on, on the host.
    expect(desktop.kill).not.toHaveBeenCalled();
    expect(desktop.broadcasts.filter((b) => b.removed).map((b) => b.workspacePath).sort()).toEqual(
      [`box:${BOX_APP}`, `box:${BOX_WT}`].sort(),
    );

    // The backup holds the records as the desktop stored them.
    const backup = readJson<{
      projects: unknown[];
      agents: AgentInfo[];
      layout: { workspaces: Record<string, unknown> };
      groups: Array<{ id: string }>;
    }>(path.join(desktopDir(), "backups", "pre-adr-227-box.json"));
    expect(backup.projects).toEqual(expectedBackupProjects);
    expect(backup.projects[0]).toMatchObject({ hostPaths: { mac: "/Users/me/box-app" } });
    expect(ids(backup.agents)).toEqual(["box-1", "box-2"]);
    expect(Object.keys(backup.layout.workspaces).sort()).toEqual([`box:${BOX_APP}`, `box:${BOX_WT}`].sort());
    expect(ids(backup.groups)).toEqual(["g1"]);

    // A relaunch keeps the adopted member in its group.
    const relaunched = openDesktop(desktopDir());
    const local = (await relaunched.projectManager.getProjects()).find((p) => p.id === "local-app")!;
    expect(local.group?.memberIds).toEqual(["local-app", "box-app", "mac-app"]);

    // The next connect is a read.
    expect(await relaunched.adoption.run("box", owner.client)).toMatchObject({
      ownership: "host",
      sent: false,
      backup: null,
    });
  });

  it("adopts an empty bundle for a host the desktop holds nothing for", async () => {
    seedDesktop(desktopDir(), { ...defaultSeed(), projects: [], groups: [], agents: [], layout: [], lastActive: null });
    const desktop = openDesktop(desktopDir());
    await h.serve();
    const owner = await h.owner();

    expect(await desktop.adoption.run("box", owner.client)).toMatchObject({
      ownership: "pending",
      sent: true,
      backup: null,
    });
    expect(
      await owner.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "host" });
    expect(hostProjects()).toEqual([]);
    expect(desktop.projectManager.isHostAdopted("box")).toBe(true);
    expect(fs.existsSync(path.join(desktopDir(), "backups"))).toBe(false);
  });

  it("abandons an adopted active agent whose pane is gone at once, not at the next boot", async () => {
    withoutGit();
    const seed = defaultSeed();
    seedDesktop(desktopDir(), {
      ...seed,
      agents: [
        // The daemon has `pane-1` (the harness starts it) and not `pane-gone`.
        agentRecord("box-live", "box", {
          status: "active",
          lastAgentStatus: "working",
          projectId: "box-app",
          paneId: "pane-1",
        }),
        agentRecord("box-gone", "box", {
          status: "active",
          lastAgentStatus: "working",
          projectId: "box-app",
          paneId: "pane-gone",
        }),
      ],
    });
    const desktop = openDesktop(desktopDir());
    await h.serve();
    const owner = await h.owner();

    await desktop.adoption.run("box", owner.client);

    const status = (id: string) => hostAgents().find((a) => a.id === id)?.status;
    await eventually(
      () => status("box-gone"),
      (value) => value === "abandoned",
      "the adopted agent whose pane is gone",
    );
    expect(status("box-live")).toBe("active");
  });

  it("lets the host win every conflict, and adds only what it lacks", async () => {
    withoutGit();
    await h.serve();
    const owner = await h.owner();
    // The host's own agent for `sess-1`, from its hook feed.
    h.daemon.emitHook(hook("SessionStart"));
    h.daemon.emitHook(hook("UserPromptSubmit"));
    await eventually(
      () => owner.invoke<AgentInfo[]>("agents", "getAll"),
      (list) => list.length === 1,
      "the host's own agent",
    );

    seedDesktop(desktopDir("laptop-1"));
    await openDesktop(desktopDir("laptop-1")).adoption.run("box", owner.client);

    // A second laptop, its records for box out of date and partly new.
    const seed = defaultSeed();
    seed.projects = [
      {
        ...(seed.projects[1] as Record<string, unknown>),
        name: "Stale name",
        workspaceNames: { [BOX_WT]: "Stale", "/home/me/new-wt": "New" },
        workspaceFolders: [
          { id: "f1", name: "Renamed elsewhere", parentId: null },
          { id: "f2", name: "Fresh", parentId: null },
        ],
        workspaceOrder: [BOX_WT, "/home/me/new-wt"],
      },
      {
        id: "box-third",
        name: "Third",
        path: "/home/me/third",
        selectedWorkspaceIndex: 0,
        workspaces: [],
        defaultBranch: "main",
        defaultRunCommand: null,
        worktreePath: null,
        hostId: "box",
      },
    ];
    seed.groups = [];
    seed.agents = [
      agentRecord("box-1", "box", { name: "Stale agent" }),
      // The same agent session as the host's own, under another id.
      agentRecord("other-id", "box", { agentSessionId: "sess-1" }),
      agentRecord("box-3", "box"),
    ];
    seed.layout = [
      persistedWorkspace(`box:${BOX_WT}`, "pane-stale", "stale"),
      persistedWorkspace("box:/home/me/new-wt", "pane-new"),
    ];
    seed.lastActive = "box:/home/me/new-wt";
    seedDesktop(desktopDir("laptop-2"), seed);
    const second = openDesktop(desktopDir("laptop-2"));

    expect(await second.adoption.run("box", owner.client)).toMatchObject({
      ownership: "host",
      sent: true,
      removed: { projects: 2, agents: 3, workspaces: 2 },
    });

    const boxApp = hostProjects().find((p) => p.id === "box-app")!;
    expect(boxApp.name).toBe("App");
    expect(boxApp.workspaceNames).toEqual({ [BOX_WT]: "Feature", "/home/me/new-wt": "New" });
    expect(boxApp.workspaceFolders).toEqual([
      { id: "f1", name: "Later", parentId: null },
      { id: "f2", name: "Fresh", parentId: null },
    ]);
    expect(boxApp.workspaceOrder).toEqual([BOX_APP, "f1", BOX_WT, "/home/me/new-wt"]);
    expect(ids(hostProjects())).toEqual(["box-app", "box-other", "box-third"]);

    const agents = hostAgents();
    expect(agents.filter((a) => a.agentSessionId === "sess-1")).toHaveLength(1);
    expect(agents.find((a) => a.id === "box-1")?.name).toBe("Agent box-1");
    expect(agents.some((a) => a.id === "other-id")).toBe(false);
    expect(agents.some((a) => a.id === "box-3")).toBe(true);

    const layout = hostLayout();
    const wt = layout.workspaces.find((w) => w.workspacePath === BOX_WT)!;
    expect(wt.panels["panel-1"].tabs[0].title).toBe("zsh");
    expect(layout.workspaces.some((w) => w.workspacePath === "/home/me/new-wt")).toBe(true);
    // The host's last active workspace stands.
    expect(layout.lastActiveWorkspacePath).toBe(BOX_WT);

    // The second laptop let go of all of it.
    expect(second.projectManager.manifestRecords("box")).toEqual([]);
    expect(second.agentManager.getAllAgents().filter((a) => a.hostId === "box")).toEqual([]);
    expect(Object.keys(second.layoutStore.getAll()).some((k) => k.startsWith("box:"))).toBe(false);
  });

  it("is harmless to send again", async () => {
    seedDesktop(desktopDir());
    const desktop = openDesktop(desktopDir());
    await desktop.layoutStore.whenLoaded();
    await h.serve();
    const owner = await h.owner();
    const bundle: AdoptionBundle = {
      projects: desktop.projectManager.manifestRecords("box"),
      agents: desktop.agentManager
        .getAllAgents()
        .filter((a) => a.hostId === "box")
        .map((a) => ({ ...a, hostId: "local" })),
      layout: {
        version: 1,
        takenAt: new Date().toISOString(),
        workspaces: Object.fromEntries(
          Object.entries(desktop.layoutStore.getAll())
            .filter(([key]) => key.startsWith("box:"))
            .map(([key, entry]) => [key.slice("box:".length), { ...entry, claims: [] }]),
        ),
        lastActiveWorkspacePath: BOX_WT,
      },
    };

    await owner.client.api.hostServer.adopt(bundle);
    const once = [hostProjects(), hostAgents(), hostLayout()];
    const again = await owner.client.api.hostServer.adopt(bundle);
    expect(again.ownership).toBe("host");
    expect([hostProjects(), hostAgents(), hostLayout()]).toEqual(once);
  });

  it("finishes on the next connect when the desktop stopped between the ack and the clean-up", async () => {
    seedDesktop(desktopDir());
    // The backup cannot be written: the run stops after the host's ack,
    // before anything local is touched — as a crash there would.
    const blocked = path.join(h.tmp, "not-a-dir");
    fs.writeFileSync(blocked, "");
    const crashing = openDesktop(desktopDir(), { backupDir: path.join(blocked, "backups") });
    await h.serve();
    const owner = await h.owner();

    await expect(crashing.adoption.run("box", owner.client)).rejects.toThrow();
    expect(
      await owner.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "host" });
    const adopted = [hostProjects(), hostAgents(), hostLayout().workspaces];
    // Both copies.
    const before = readJson<PersistedState>(path.join(desktopDir(), "projects.json"));
    expect(ids(before.projects)).toContain("box-app");
    expect(before.hosts?.box).not.toHaveProperty("adopted");

    // Relaunched.
    const desktop = openDesktop(desktopDir());
    expect(await desktop.adoption.run("box", owner.client)).toMatchObject({
      ownership: "host",
      removed: { projects: 2, agents: 2, workspaces: 2 },
    });
    // Nothing doubled on the host.
    expect([hostProjects(), hostAgents(), hostLayout().workspaces]).toEqual(adopted);
    const after = readJson<PersistedState>(path.join(desktopDir(), "projects.json"));
    expect(ids(after.projects)).toEqual(["local-app", "mac-app"]);
    expect(after.hosts?.box).toMatchObject({ adopted: true });
    expect(fs.existsSync(path.join(desktopDir(), "backups", "pre-adr-227-box.json"))).toBe(true);
  });

  it("finishes when the desktop stopped part-way through the clean-up", async () => {
    // The desktop reads the host's projects back after each hand-over.
    withoutGit();
    seedDesktop(desktopDir());
    const crashing = openDesktop(desktopDir());
    crashing.agentManager.removeAgents = () => {
      throw new Error("killed");
    };
    await h.serve();
    const owner = await h.owner();
    await expect(crashing.adoption.run("box", owner.client)).rejects.toThrow("killed");
    // The projects went; the agents and layout did not.
    expect(crashing.projectManager.manifestRecords("box")).toEqual([]);

    const desktop = openDesktop(desktopDir());
    expect(await desktop.adoption.run("box", owner.client)).toMatchObject({
      ownership: "host",
      sent: true,
      removed: { projects: 0, agents: 2, workspaces: 2 },
    });
    expect(desktop.projectManager.isHostAdopted("box")).toBe(true);
    expect(ids(hostAgents())).toEqual(["box-1", "box-2"]);
    // A second backup beside the first, never over it.
    expect(fs.readdirSync(path.join(desktopDir(), "backups"))).toHaveLength(2);
  });

  it("refuses a malformed bundle whole", async () => {
    await h.serve();
    const owner = await h.owner();
    const bad = {
      projects: [{ id: "p", name: "P", path: "/p", hostId: "box" }],
      agents: [],
      layout: { version: 1, takenAt: "now", workspaces: {}, lastActiveWorkspacePath: null },
    };
    await expect(owner.invoke("hostServer", "adopt", bad)).rejects.toThrow(/hostId/);
    expect(
      await owner.invoke<HostServerStatus>("hostServer", "status"),
    ).toMatchObject({ ownership: "pending" });
    expect(fs.existsSync(h.paths.projects)).toBe(false);
  });
});
