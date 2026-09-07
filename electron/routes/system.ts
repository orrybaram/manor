/**
 * The app-level control surface: notifications, processes, ports,
 * preferences, theme, stats, remote control, the shell escape hatches,
 * windows, and the updater (ADR-171).
 *
 * Every route here mirrors one `ipcMain.handle` in `../ipc/*`, calling the
 * same manager method with the same validation — where that handler carried
 * logic inline it was first extracted to a plain function (`../process-control`,
 * `../editor`, `listWindows` in `../ipc/window`) so neither caller owns a
 * private copy.
 *
 * The managers are nullable on `ControlDeps` (a unit test may construct a
 * server with none, and `WebviewServer`'s constructor still only takes six of
 * them), so each handler opens with `requireDep`: a missing manager is a
 * capability gap, `503`, never a crash.
 */

import { shell } from "electron";
import {
  listProcesses,
  cleanupDeadProcesses,
  killDaemon,
  killAllProcesses,
  restartPortless,
} from "../process-control";
import { openInEditor } from "../editor";
import { sendNotificationsUpdate } from "../notifications";
import { checkForUpdates, quitAndInstall } from "../updater";
import { listWindows } from "../ipc/window";
import { isPreferenceKey } from "../preferences";
import type { TunnelKind } from "../remote-control/tunnel";
import type { ControlDeps, Json, Route } from "./types";

/**
 * Resolve one manager off the bag or answer `503`. Returns `null` when it
 * responded, so callers read `const x = requireDep(…); if (!x) return;`.
 */
function requireDep<K extends keyof ControlDeps>(
  deps: ControlDeps,
  key: K,
  label: string,
  json: Json,
): NonNullable<ControlDeps[K]> | null {
  const value = deps[key];
  if (!value) {
    json(503, { error: `${label} is not available` });
    return null;
  }
  return value as NonNullable<ControlDeps[K]>;
}

/**
 * Re-broadcast the whole notification list after a mutation, through the same
 * single send-site `../ipc/notifications.ts` uses — the renderer keeps a cache
 * of main's list and never mutates its copy, so a mutation nobody announced is
 * a stale sidebar.
 */
function broadcastNotifications(deps: ControlDeps): void {
  const windows = deps.getRendererWindows?.() ?? [];
  sendNotificationsUpdate(windows[0] ?? null);
}

/** Protocols `shell:openExternal` allows; anything else is a 400. */
const ALLOWED_PROTOCOLS = [
  "https:",
  "http:",
  "file:",
  "x-apple.systempreferences:",
];

function isTunnelKind(value: unknown): value is TunnelKind {
  return value === "tailscale" || value === "cloudflared";
}

export const systemRoutes: Route[] = [
  // ── Notifications ──

  {
    method: "GET",
    path: "/notifications",
    async handler({ deps, json }) {
      const store = requireDep(
        deps,
        "notificationStore",
        "Notifications",
        json,
      );
      if (!store) return;
      json(200, store.getAll());
    },
  },

  {
    method: "DELETE",
    path: "/notifications",
    async handler({ deps, json }) {
      const store = requireDep(
        deps,
        "notificationStore",
        "Notifications",
        json,
      );
      if (!store) return;
      store.clear();
      broadcastNotifications(deps);
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/notifications/read-all",
    async handler({ deps, json }) {
      const store = requireDep(
        deps,
        "notificationStore",
        "Notifications",
        json,
      );
      if (!store) return;
      store.markAllRead();
      broadcastNotifications(deps);
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/notifications/:id/read",
    async handler({ deps, params, json }) {
      const store = requireDep(
        deps,
        "notificationStore",
        "Notifications",
        json,
      );
      if (!store) return;
      // `markRead` is false for an id that is unknown *or* already read; only
      // a real transition is worth a broadcast, exactly as the IPC path.
      const changed = store.markRead(params.id);
      if (changed) broadcastNotifications(deps);
      json(200, { ok: true, changed });
    },
  },

  // ── Processes ──

  {
    method: "GET",
    path: "/processes",
    async handler({ deps, json }) {
      const backend = requireDep(deps, "backend", "Terminal backend", json);
      if (!backend) return;
      const agentHookServer = requireDep(
        deps,
        "agentHookServer",
        "Agent hook server",
        json,
      );
      if (!agentHookServer) return;
      const webviewServer = requireDep(
        deps,
        "webviewServer",
        "Webview server",
        json,
      );
      if (!webviewServer) return;
      const portScanner = requireDep(deps, "portScanner", "Port scanner", json);
      if (!portScanner) return;
      json(
        200,
        await listProcesses({
          backend,
          agentHookServer,
          webviewServer,
          portScanner,
        }),
      );
    },
  },

  {
    method: "POST",
    path: "/processes/cleanup-dead",
    async handler({ deps, json }) {
      const backend = requireDep(deps, "backend", "Terminal backend", json);
      if (!backend) return;
      json(200, await cleanupDeadProcesses(backend));
    },
  },

  {
    // Destructive: SIGTERMs the terminal daemon, taking every session with it.
    method: "POST",
    path: "/processes/kill-daemon",
    async handler({ json }) {
      await killDaemon();
      json(200, { ok: true });
    },
  },

  {
    // Destructive: kills every session, every workspace port, and the daemon.
    method: "POST",
    path: "/processes/kill-all",
    async handler({ deps, json }) {
      const backend = requireDep(deps, "backend", "Terminal backend", json);
      if (!backend) return;
      const agentManager = requireDep(
        deps,
        "agentManager",
        "Agent management",
        json,
      );
      if (!agentManager) return;
      const statsStore = requireDep(deps, "statsStore", "Usage stats", json);
      if (!statsStore) return;
      const portScanner = requireDep(deps, "portScanner", "Port scanner", json);
      if (!portScanner) return;
      await killAllProcesses({
        backend,
        agentManager,
        statsStore,
        portScanner,
      });
      json(200, { ok: true });
    },
  },

  {
    method: "POST",
    path: "/processes/restart-portless",
    async handler({ json }) {
      await restartPortless();
      json(200, { ok: true });
    },
  },

  // ── Ports ──

  {
    method: "GET",
    path: "/ports",
    async handler({ deps, json }) {
      const portScanner = requireDep(deps, "portScanner", "Port scanner", json);
      if (!portScanner) return;
      json(200, await portScanner.scanNow());
    },
  },

  {
    method: "POST",
    path: "/ports/kill",
    async handler({ deps, json, readBody }) {
      const backend = requireDep(deps, "backend", "Terminal backend", json);
      if (!backend) return;
      const body = await readBody();
      const pid = body.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        json(400, { error: "Missing positive integer 'pid' in request body" });
        return;
      }
      try {
        await backend.ports.kill(pid);
      } catch {
        // Process may have already exited — the IPC path ignores this too.
      }
      json(200, { ok: true });
    },
  },

  // ── Preferences ──

  {
    method: "GET",
    path: "/preferences",
    async handler({ deps, json }) {
      const prefs = requireDep(deps, "preferencesManager", "Preferences", json);
      if (!prefs) return;
      json(200, prefs.getAll());
    },
  },

  {
    method: "POST",
    path: "/preferences",
    async handler({ deps, json, readBody }) {
      const prefs = requireDep(deps, "preferencesManager", "Preferences", json);
      if (!prefs) return;
      const body = await readBody();
      const key = body.key;
      // Unlike the renderer — which only ever sends keys its settings UI knows
      // — an HTTP caller can send anything, and an unknown key would be written
      // to disk and read back by nothing. Reject it.
      if (typeof key !== "string" || !isPreferenceKey(key)) {
        json(400, { error: `Unknown preference key '${String(key)}'` });
        return;
      }
      if (body.value === undefined) {
        json(400, { error: "Missing 'value' in request body" });
        return;
      }
      // `as never` for the same reason `preferences:set` uses it: `key` is a
      // union of every preference name, so its value type is a union `set`'s
      // generic cannot narrow from a runtime string.
      prefs.set(key, body.value as never);
      json(200, { ok: true });
    },
  },

  // ── Theme ──

  {
    method: "GET",
    path: "/theme",
    async handler({ deps, json }) {
      const themeManager = requireDep(deps, "themeManager", "Themes", json);
      if (!themeManager) return;
      json(200, {
        name: themeManager.getSelectedThemeName(),
        theme: themeManager.getTheme(),
      });
    },
  },

  {
    method: "POST",
    path: "/theme",
    async handler({ deps, json, readBody }) {
      const themeManager = requireDep(deps, "themeManager", "Themes", json);
      if (!themeManager) return;
      const body = await readBody();
      const name = body.name;
      if (typeof name !== "string" || !name) {
        json(400, { error: "Missing 'name' string in request body" });
        return;
      }
      themeManager.setSelectedThemeName(name);
      json(200, { name, theme: themeManager.getTheme() });
    },
  },

  {
    method: "GET",
    path: "/theme/all",
    async handler({ deps, json }) {
      const themeManager = requireDep(deps, "themeManager", "Themes", json);
      if (!themeManager) return;
      json(200, await themeManager.loadAllThemeColors());
    },
  },

  // ── Stats ──

  {
    method: "GET",
    path: "/stats",
    async handler({ deps, json }) {
      const statsStore = requireDep(deps, "statsStore", "Usage stats", json);
      if (!statsStore) return;
      json(200, statsStore.getSummary());
    },
  },

  {
    // Destructive: deletes every recorded stat and badge.
    method: "DELETE",
    path: "/stats",
    async handler({ deps, json }) {
      const statsStore = requireDep(deps, "statsStore", "Usage stats", json);
      if (!statsStore) return;
      statsStore.reset();
      json(200, { ok: true });
    },
  },

  // ── Remote control ──
  //
  // The controller throws for the orders it refuses (starting a tunnel with
  // the listener down, with neither tunnel binary installed): that is the
  // caller's mistake, so it becomes a 400 carrying the controller's sentence
  // rather than the listener's generic 500.

  {
    method: "GET",
    path: "/remote-control",
    async handler({ deps, json }) {
      const remoteControl = requireDep(
        deps,
        "remoteControl",
        "Remote control",
        json,
      );
      if (!remoteControl) return;
      json(200, remoteControl.status());
    },
  },

  {
    method: "POST",
    path: "/remote-control/enabled",
    async handler({ deps, json, readBody }) {
      const remoteControl = requireDep(
        deps,
        "remoteControl",
        "Remote control",
        json,
      );
      if (!remoteControl) return;
      const body = await readBody();
      if (typeof body.enabled !== "boolean") {
        json(400, { error: "Missing 'enabled' boolean in request body" });
        return;
      }
      try {
        json(200, await remoteControl.setEnabled(body.enabled));
      } catch (err) {
        json(400, { error: String(err) });
      }
    },
  },

  {
    method: "POST",
    path: "/remote-control/refresh",
    async handler({ deps, json }) {
      const remoteControl = requireDep(
        deps,
        "remoteControl",
        "Remote control",
        json,
      );
      if (!remoteControl) return;
      json(200, await remoteControl.refreshDetection());
    },
  },

  {
    method: "POST",
    path: "/remote-control/tunnel/start",
    async handler({ deps, json, readBody }) {
      const remoteControl = requireDep(
        deps,
        "remoteControl",
        "Remote control",
        json,
      );
      if (!remoteControl) return;
      const body = await readBody();
      const kind = body.kind;
      if (kind !== undefined && !isTunnelKind(kind)) {
        json(400, { error: "'kind' must be 'tailscale' or 'cloudflared'" });
        return;
      }
      try {
        json(200, await remoteControl.startTunnel(kind));
      } catch (err) {
        json(400, { error: String(err) });
      }
    },
  },

  {
    method: "POST",
    path: "/remote-control/tunnel/stop",
    async handler({ deps, json }) {
      const remoteControl = requireDep(
        deps,
        "remoteControl",
        "Remote control",
        json,
      );
      if (!remoteControl) return;
      json(200, await remoteControl.stopTunnel());
    },
  },

  // ── Shell ──

  {
    method: "POST",
    path: "/shell/open-in-editor",
    async handler({ deps, json, readBody }) {
      const prefs = requireDep(deps, "preferencesManager", "Preferences", json);
      if (!prefs) return;
      const body = await readBody();
      const dirPath = body.path;
      if (typeof dirPath !== "string" || !dirPath) {
        json(400, { error: "Missing 'path' string in request body" });
        return;
      }
      // Both `openInEditor` branches report failure the same way: a non-empty
      // string. Empty (or undefined) means it opened.
      const error = await openInEditor(prefs, dirPath);
      json(200, { ok: !error, error: error ? error : null });
    },
  },

  {
    method: "POST",
    path: "/shell/open-external",
    async handler({ json, readBody }) {
      const body = await readBody();
      const target = body.url;
      if (typeof target !== "string") {
        json(400, { error: "Missing 'url' string in request body" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        json(400, { error: "Invalid URL format" });
        return;
      }
      if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
        json(400, { error: `Blocked protocol: ${parsed.protocol}` });
        return;
      }
      await shell.openExternal(target);
      json(200, { ok: true });
    },
  },

  // ── Windows ──

  {
    method: "GET",
    path: "/windows",
    async handler({ deps, json }) {
      const getRendererWindows = requireDep(
        deps,
        "getRendererWindows",
        "Window listing",
        json,
      );
      if (!getRendererWindows) return;
      // No exclusion: `window:listWindows` drops the calling window because a
      // renderer cannot drop a tab into itself; an HTTP caller is not a window.
      json(200, listWindows(getRendererWindows()));
    },
  },

  // ── Updater ──

  {
    method: "POST",
    path: "/updater/check",
    async handler({ json }) {
      checkForUpdates();
      json(200, { ok: true });
    },
  },

  {
    // Destructive: quits Manor immediately to install a downloaded update.
    method: "POST",
    path: "/updater/quit-and-install",
    async handler({ json }) {
      // Respond before quitting: `quitAndInstall` tears the process down, and
      // a caller that never got a reply cannot tell success from a crash.
      json(200, { ok: true });
      setImmediate(() => quitAndInstall());
    },
  },
];
