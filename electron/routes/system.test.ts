/**
 * `routes/system.ts` — the behaviours that are this module's own rather than
 * the manager's: the notification re-broadcast (through the bridge's own
 * `notifications.*` handlers), the preference-key allowlist, and the
 * extracted `listProcesses` being the one the route calls. Modeled on
 * `git.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => {}) },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { isPackaged: false },
  screen: {},
}));

vi.mock("electron-updater", () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}));

vi.mock("../notifications", () => ({
  sendNotificationsUpdate: vi.fn(),
  showPrNotification: vi.fn(),
}));

vi.mock("../process-control", () => ({
  listProcesses: vi.fn(async () => ({
    daemon: { pid: 42, alive: true },
    internalServers: [],
    sessions: [],
    ports: [],
  })),
  cleanupDeadProcesses: vi.fn(async () => ({ success: true })),
  killDaemon: vi.fn(async () => {}),
  killAllProcesses: vi.fn(async () => {}),
  restartPortless: vi.fn(async () => {}),
}));

import { sendNotificationsUpdate } from "../notifications";
import { listProcesses } from "../process-control";
import { systemRoutes } from "./system";
import type { HostDeps, Route } from "./types";

function route(method: Route["method"], path: string): Route {
  const found = systemRoutes.find(
    (r) => r.method === method && r.path === path,
  );
  if (!found) throw new Error(`No route ${method} ${path}`);
  return found;
}

async function call(
  r: Route,
  deps: Partial<HostDeps>,
  opts: {
    params?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
) {
  const calls: Array<{ status: number; body: unknown }> = [];
  await r.handler({
    deps: deps as unknown as HostDeps,
    params: opts.params ?? {},
    url: new URL(`http://localhost${r.path}`),
    json: (status, body) => calls.push({ status, body }),
    readBody: async () => opts.body ?? {},
  });
  return calls[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notification routes", () => {
  /** A store whose `markRead` reports whether the id was a real transition. */
  function notificationStore(markReadResult: boolean) {
    return {
      getAll: () => [],
      markRead: vi.fn(() => markReadResult),
      markAllRead: vi.fn(),
      clear: vi.fn(),
    } as unknown as HostDeps["notificationStore"];
  }

  it("re-broadcasts the list after a mark-read", async () => {
    const store = notificationStore(true);
    const res = await call(
      route("POST", "/notifications/:id/read"),
      { notificationStore: store },
      { params: { id: "n1" } },
    );

    expect(res).toEqual({ status: 200, body: { ok: true, changed: true } });
    expect(store.markRead).toHaveBeenCalledWith("n1");
    expect(sendNotificationsUpdate).toHaveBeenCalledWith();
  });

  it("skips the broadcast when the id changed nothing", async () => {
    const res = await call(
      route("POST", "/notifications/:id/read"),
      { notificationStore: notificationStore(false) },
      { params: { id: "gone" } },
    );

    expect(res.body).toEqual({ ok: true, changed: false });
    expect(sendNotificationsUpdate).not.toHaveBeenCalled();
  });

  it("broadcasts after a mark-all-read", async () => {
    const store = notificationStore(true);
    await call(route("POST", "/notifications/read-all"), {
      notificationStore: store,
    });

    expect(store.markAllRead).toHaveBeenCalled();
    expect(sendNotificationsUpdate).toHaveBeenCalledWith();
  });
});

describe("GET /processes", () => {
  it("returns what the extracted listProcesses reports", async () => {
    const deps: Partial<HostDeps> = {
      backend: {} as HostDeps["backend"],
      agentHookServer: { hookPort: 1 } as HostDeps["agentHookServer"],
      webviewServer: { serverPort: 2 } as HostDeps["webviewServer"],
      portScanner: {} as HostDeps["portScanner"],
    };
    const res = await call(route("GET", "/processes"), deps);

    expect(listProcesses).toHaveBeenCalledWith({
      backend: deps.backend,
      agentHookServer: deps.agentHookServer,
      webviewServer: deps.webviewServer,
      portScanner: deps.portScanner,
    });
    expect(res).toEqual({
      status: 200,
      body: {
        daemon: { pid: 42, alive: true },
        internalServers: [],
        sessions: [],
        ports: [],
      },
    });
  });
});

describe("POST /preferences", () => {
  function preferencesManager() {
    return {
      getAll: () => ({}),
      set: vi.fn(),
    } as unknown as HostDeps["preferencesManager"];
  }

  it("400s an unknown key without touching the manager", async () => {
    const prefs = preferencesManager();
    const res = await call(
      route("POST", "/preferences"),
      { preferencesManager: prefs },
      { body: { key: "notAPreference", value: true } },
    );

    expect(res.status).toBe(400);
    expect(prefs!.set).not.toHaveBeenCalled();
  });

  it("writes a known key", async () => {
    const prefs = preferencesManager();
    const res = await call(
      route("POST", "/preferences"),
      { preferencesManager: prefs },
      { body: { key: "dockBadgeEnabled", value: false } },
    );

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(prefs!.set).toHaveBeenCalledWith("dockBadgeEnabled", false);
  });
});

describe("GET /theme", () => {
  it("returns the selected name alongside the resolved theme", async () => {
    const res = await call(route("GET", "/theme"), {
      themeManager: {
        getSelectedThemeName: () => "Dracula",
        getTheme: () => ({ background: "#282a36" }),
      } as unknown as HostDeps["themeManager"],
    });

    expect(res).toEqual({
      status: 200,
      body: { name: "Dracula", theme: { background: "#282a36" } },
    });
  });
});
