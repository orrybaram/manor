/**
 * A desktop's records before adoption, on disk, and the
 * desktop's stores opened over them — for `host-adoption.test.ts` and the
 * host server's `adoption.test.ts`.
 *
 * Two remote hosts, `box` and `mac`, beside this machine: projects on each,
 * linked in one group; agents on each; and a layout entry for each.
 */

import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

import { AgentManager, type AgentInfo } from "../../agent-persistence";
import { LayoutStore } from "../../layout/layout-store";
import { ProjectManager } from "../../projects/project-manager";
import { LayoutPersistence } from "../../terminal-host/layout-persistence";
import type { LayoutBroadcast } from "../../../src/lib/layout/protocol";
import type { GitBackend } from "../types";
import { HostAdoption, type HostAdoptionOptions } from "../host-adoption";

/** Recent, so the agent store's retention keeps every record. */
export const NOW = new Date().toISOString();

export const BOX_APP = "/home/me/box-app";
export const BOX_WT = "/home/me/.manor/worktrees/box-app/feature";

export function agentRecord(
  id: string,
  hostId: string,
  extra: Partial<AgentInfo> = {},
): AgentInfo {
  return {
    id,
    agentSessionId: `sess-${id}`,
    name: `Agent ${id}`,
    status: "completed",
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    activatedAt: null,
    projectId: null,
    projectName: null,
    hostId,
    workspacePath: null,
    cwd: "/",
    agentKind: "claude",
    agentCommand: null,
    paneId: null,
    lastAgentStatus: null,
    resumedAt: null,
    transcriptPath: null,
    ...extra,
  };
}

/** One workspace's layout as `layout.json` holds it: a tab with one pane. */
export function persistedWorkspace(key: string, paneId: string, title = "zsh") {
  return {
    workspacePath: key,
    panelTree: { type: "leaf", panelId: "panel-1" },
    panels: {
      "panel-1": {
        id: "panel-1",
        tabs: [
          {
            id: `tab-${paneId}`,
            title,
            rootNode: { type: "leaf", paneId },
            paneSessions: {
              [paneId]: { daemonSessionId: paneId, lastCwd: "/tmp", lastTitle: null },
            },
          },
        ],
        pinnedTabIds: [],
      },
    },
    defaultViewport: {
      activePanelId: "panel-1",
      selectedTabIds: { "panel-1": `tab-${paneId}` },
      focusedPaneIds: {},
    },
  };
}

function project(id: string, projectPath: string, hostId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `Project ${id}`,
    path: projectPath,
    selectedWorkspaceIndex: 0,
    workspaces: [],
    defaultBranch: "main",
    defaultRunCommand: null,
    worktreePath: null,
    ...(hostId ? { hostId } : {}),
    ...extra,
  };
}

/** What the desktop's files hold before adoption; each part replaceable. */
export interface DesktopSeed {
  projects: unknown[];
  groups: unknown[];
  agents: AgentInfo[];
  layout: unknown[];
  lastActive: string | null;
}

export function defaultSeed(): DesktopSeed {
  return {
    projects: [
      project("local-app", "/Users/me/app", null),
      project("box-app", BOX_APP, "box", {
        hostPaths: { mac: "/Users/me/box-app" },
        workspaceNames: { [BOX_WT]: "Feature" },
        workspaceIssues: {
          [BOX_WT]: [{ id: "i1", identifier: "ENG-1", title: "Fix it", url: "https://linear.app/i1" }],
        },
        workspaceHidden: { "/home/me/old": true },
        workspaceFolders: [{ id: "f1", name: "Later", parentId: null }],
        workspaceFolderIds: { [BOX_WT]: "f1" },
        workspaceOrder: [BOX_APP, "f1", BOX_WT],
      }),
      project("box-other", "/home/me/other", "box", { color: "green" }),
      project("mac-app", "/Users/me/mac-app", "mac"),
    ],
    groups: [
      {
        id: "g1",
        name: "App",
        memberIds: ["local-app", "box-app", "mac-app"],
        lastUsedHostId: "box",
        color: "red",
      },
    ],
    agents: [
      agentRecord("local-1", "local"),
      agentRecord("box-1", "box", { projectId: "box-app", workspacePath: BOX_WT, paneId: "pane-box" }),
      agentRecord("box-2", "box", { status: "abandoned" }),
      agentRecord("mac-1", "mac"),
    ],
    layout: [
      persistedWorkspace("/Users/me/app", "pane-local"),
      persistedWorkspace(`box:${BOX_WT}`, "pane-box"),
      persistedWorkspace(`box:${BOX_APP}`, "pane-box-main"),
      persistedWorkspace("mac:/Users/me/mac-app", "pane-mac"),
    ],
    lastActive: `box:${BOX_WT}`,
  };
}

/** Write `seed` as a desktop's `projects.json`, `agents.json` and `layout.json`. */
export function seedDesktop(dir: string, seed: DesktopSeed = defaultSeed()): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "projects.json"),
    JSON.stringify({
      projects: seed.projects,
      selectedProjectIndex: 1,
      hosts: {
        box: { spec: { kind: "ssh", target: "me@box" }, lastHookSeq: 7 },
        mac: { spec: { kind: "ssh", target: "me@mac" } },
      },
      ...(seed.groups.length > 0 ? { groups: seed.groups } : {}),
    }),
  );
  fs.writeFileSync(path.join(dir, "agents.json"), JSON.stringify({ agents: seed.agents }));
  fs.writeFileSync(
    path.join(dir, "layout.json"),
    JSON.stringify({ version: 4, workspaces: seed.layout, lastActiveWorkspacePath: seed.lastActive }),
  );
}

/** The desktop's own stores over `dir`, as a launch would open them. */
export function openDesktop(dir: string, opts: Partial<HostAdoptionOptions> = {}) {
  const git = {
    exec: async () => {
      throw new Error("no git here");
    },
    worktreeList: async () => [],
  } as unknown as GitBackend;
  const projectManager = new ProjectManager(git, dir);
  const agentManager = new AgentManager(dir);
  const broadcasts: LayoutBroadcast[] = [];
  const kill = vi.fn(async () => {});
  const layoutStore = new LayoutStore(
    new LayoutPersistence(path.join(dir, "layout.json")),
    (payload) => broadcasts.push(payload),
    { pty: { kill } },
  );
  void layoutStore.startLoad(Promise.resolve());
  const adoption = new HostAdoption({
    projectManager,
    agentManager,
    layoutStore,
    getPaneHostId: () => undefined,
    backupDir: path.join(dir, "backups"),
    log: { info: () => {}, warn: () => {} },
    ...opts,
  });
  return { projectManager, agentManager, layoutStore, broadcasts, kill, adoption };
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}
