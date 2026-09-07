/**
 * MCP tools for Manor's app-level surface (ADR-171): notifications,
 * processes, ports, preferences, theme, stats, remote control, the shell
 * escape hatches, windows, the updater, and the two issue-tracker actions
 * that write. Thin wrappers over `/…` in `../routes/system.ts` and
 * `../routes/integrations.ts`.
 *
 * Reads render a compact line per row rather than dumping the wire JSON — the
 * exceptions are `get_preferences` and `get_stats`, which are flat objects
 * whose every field is the answer.
 *
 * Anything that kills a process, drops persisted data, or quits the app says
 * so in the first sentence of its description: that sentence is the whole of
 * what `manor --help` shows, so a destructive command has to be legible there.
 */

import { resolveProjectId, resolveWorkspacePath } from "./context";
import type { ToolDef, ToolModule } from "./types";
import { text } from "./types";

interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  timestamp: string;
  read: boolean;
}

interface ProcessesSnapshot {
  daemon: { pid: number | null; alive: boolean };
  internalServers: Array<{ name: string; port: number | null }>;
  sessions: Array<{
    sessionId: string;
    alive: boolean;
    cwd: string | null;
    orphaned: boolean;
  }>;
  ports: PortRow[];
}

interface PortRow {
  port: number;
  processName: string;
  pid: number;
  workspacePath: string | null;
}

interface RemoteControlStatusRow {
  enabled: boolean;
  port: number | null;
  devices: Array<{ id: string; label: string }>;
  tunnel: { state: string; kind: string | null; url: string | null };
  detected: Record<string, boolean>;
  listeners: number;
}

interface WindowRow {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * The CLI hands every flag through as a string, so `--value true` would set
 * the string `"true"` into a boolean preference and quietly break whatever
 * reads it. Parse anything that is valid JSON (booleans, numbers, null,
 * objects, arrays, quoted strings) and leave everything else the bare string
 * it looks like — `--value "Sosumi"` must stay `"Sosumi"`.
 */
function parsePreferenceValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Render a remote-control status the same way for all five of its tools. */
function formatRemoteStatus(status: RemoteControlStatusRow): string {
  const lines = [
    `Remote control: ${status.enabled ? `on (port ${status.port})` : "off"}`,
    `Tunnel: ${status.tunnel.state}${status.tunnel.kind ? ` (${status.tunnel.kind})` : ""}${
      status.tunnel.url ? ` — ${status.tunnel.url}` : ""
    }`,
    `Paired devices: ${status.devices.length}`,
    `Live listeners: ${status.listeners}`,
    `Tunnel binaries on PATH: ${
      Object.entries(status.detected)
        .filter(([, present]) => present)
        .map(([kind]) => kind)
        .join(", ") || "none"
    }`,
  ];
  return lines.join("\n");
}

// ── Tool definitions ──

const tools: ToolDef[] = [
  // ── Notifications ──
  {
    name: "list_notifications",
    description: "List Manor's notification log, newest last.",
    inputSchema: {
      type: "object" as const,
      properties: {
        unreadOnly: {
          type: "boolean",
          description: "List only unread notifications.",
        },
      },
    },
  },
  {
    name: "mark_notification_read",
    description: "Mark one notification as read.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Notification id, from list_notifications.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "mark_all_notifications_read",
    description: "Mark every notification as read.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "clear_notifications",
    description:
      "Destructive: deletes the entire notification log. It is not recoverable — mark_all_notifications_read clears the unread badge without losing the history.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Processes ──
  {
    name: "list_processes",
    description:
      "Show Manor's terminal daemon, internal servers, live sessions, and the ports they hold.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "cleanup_dead_processes",
    description:
      "Dispose terminal sessions whose processes have already exited.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "kill_daemon",
    description:
      "Destructive: kills Manor's terminal daemon, ending every terminal session in every workspace. Anything running in a pane dies with it.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "kill_all_processes",
    description:
      "Destructive: kills every terminal session, every workspace dev server, and the daemon itself. The nuclear option — kill_daemon or kill_port are the narrower ones.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "restart_portless",
    description:
      "Restart the portless proxy that serves workspace dev servers on named hostnames.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Ports ──
  {
    name: "scan_ports",
    description:
      "List listening ports Manor can see, with the process holding each.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "kill_port",
    description:
      "Destructive: kills the process holding a port. Find the pid with scan_ports first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pid: {
          type: "number",
          description: "Process id, from scan_ports.",
        },
      },
      required: ["pid"],
    },
  },

  // ── Preferences ──
  {
    name: "get_preferences",
    description: "Show every Manor preference and its current value.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_preference",
    description:
      "Set one Manor preference. The value is JSON-parsed when it parses — 'true', '42' and 'false' become a boolean or number, so booleans and numbers work from the shell, while anything that is not valid JSON stays the literal string. Run get_preferences for the key names.",
    inputSchema: {
      type: "object" as const,
      properties: {
        key: {
          type: "string",
          description: "Preference key, as shown by get_preferences.",
        },
        value: {
          type: "string",
          description:
            "New value. JSON-parsed when it parses as JSON, otherwise used as a string.",
        },
      },
      required: ["key", "value"],
    },
  },

  // ── Theme ──
  {
    name: "get_theme",
    description: "Show the selected theme's name and its resolved colors.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "list_themes",
    description:
      "List every theme Manor can load, with each one's background color.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_theme",
    description: "Switch Manor to a theme by name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description: "Theme name, as shown by list_themes.",
        },
      },
      required: ["name"],
    },
  },

  // ── Stats ──
  {
    name: "get_stats",
    description:
      "Show Manor's usage stats: today, the last 7 days, all time, and badges.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "reset_stats",
    description:
      "Destructive: deletes every recorded usage stat and earned badge. There is no undo and no backup.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Remote control ──
  {
    name: "remote_control_status",
    description:
      "Show whether remote control is on, which devices are paired, and the tunnel's state.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "set_remote_control_enabled",
    description:
      "Turn remote control's local listener on or off. Turning it off also stops any running tunnel. Pairing a device stays in the UI.",
    inputSchema: {
      type: "object" as const,
      properties: {
        enabled: {
          type: "boolean",
          description: "True to start the listener, false to stop it.",
        },
      },
      required: ["enabled"],
    },
  },
  {
    name: "start_tunnel",
    description:
      "Expose the remote-control listener through a tunnel. Requires remote control to be on and tailscale or cloudflared on PATH; Manor installs neither.",
    inputSchema: {
      type: "object" as const,
      properties: {
        kind: {
          type: "string",
          enum: ["tailscale", "cloudflared"],
          description:
            "Which tunnel to use. Defaults to tailscale when it is installed.",
        },
      },
    },
  },
  {
    name: "stop_tunnel",
    description:
      "Stop the running tunnel, leaving the remote-control listener up on loopback.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Shell ──
  {
    name: "open_in_editor",
    description:
      "Open a directory in the editor configured in Manor's preferences, or the system default.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Directory to open. Defaults to the workspace this agent is running in.",
        },
      },
    },
  },
  {
    name: "open_external",
    description:
      "Open a URL in the user's default browser. http, https, file and x-apple.systempreferences only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "URL to open." },
      },
      required: ["url"],
    },
  },

  // ── Windows ──
  {
    name: "list_windows",
    description:
      "List Manor's visible windows with their screen bounds, most-recently-focused first.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Updater ──
  {
    name: "check_for_updates",
    description:
      "Ask Manor to check for an update. The result arrives in the app's UI, not here.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "quit_and_install",
    description:
      "Destructive: quits Manor immediately to install a downloaded update. Every terminal pane goes with it — check with the user first.",
    inputSchema: { type: "object" as const, properties: {} },
  },

  // ── Integrations ──
  {
    name: "start_linear_issue",
    description: "Move a Linear issue to started and assign it to you.",
    inputSchema: {
      type: "object" as const,
      properties: {
        issueId: {
          type: "string",
          description: "Linear issue id or identifier (e.g. 'ENG-123').",
        },
      },
      required: ["issueId"],
    },
  },
  {
    name: "close_linear_issue",
    description: "Move a Linear issue to its team's completed state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        issueId: {
          type: "string",
          description: "Linear issue id or identifier (e.g. 'ENG-123').",
        },
      },
      required: ["issueId"],
    },
  },
  {
    name: "github_status",
    description: "Report whether the gh CLI is installed and authenticated.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "create_github_issue",
    description:
      "Create a GitHub issue on a project's repository. Runs gh inside the project's checkout, so the repo is the project's, never one named here.",
    inputSchema: {
      type: "object" as const,
      properties: {
        projectId: {
          type: "string",
          description:
            "Project whose repo gets the issue. Defaults to the project this agent is running in.",
        },
        title: { type: "string", description: "Issue title." },
        body: { type: "string", description: "Issue body, as markdown." },
        labels: {
          type: "array",
          items: { type: "string" },
          description:
            "Labels to apply. Dropped (and the issue still created) if the repo has no such label.",
        },
      },
      required: ["title"],
    },
  },
];

// ── Tool handlers ──

const handlers: ToolModule["handlers"] = {
  // ── Notifications ──

  async list_notifications(args, http) {
    const all = (await http.get("/notifications")) as NotificationRow[];
    const rows = args.unreadOnly ? all.filter((n) => !n.read) : all;
    if (rows.length === 0) {
      return text(
        args.unreadOnly ? "No unread notifications." : "No notifications.",
      );
    }
    return text(
      rows
        .map(
          (n) =>
            `${n.read ? "     " : "[new]"} ${n.timestamp} ${n.kind}: ${n.title} (${n.id})`,
        )
        .join("\n"),
    );
  },

  async mark_notification_read(args, http) {
    const id = args.id as string;
    const result = (await http.post(
      `/notifications/${encodeURIComponent(id)}/read`,
    )) as { changed: boolean };
    return text(
      result.changed
        ? `Marked ${id} read.`
        : `${id} was already read, or no notification has that id.`,
    );
  },

  async mark_all_notifications_read(_args, http) {
    await http.post("/notifications/read-all");
    return text("All notifications marked read.");
  },

  async clear_notifications(_args, http) {
    await http.del("/notifications");
    return text("Notification log cleared.");
  },

  // ── Processes ──

  async list_processes(_args, http) {
    const snapshot = (await http.get("/processes")) as ProcessesSnapshot;
    const lines: string[] = [];
    lines.push(
      `Daemon: ${
        snapshot.daemon.pid === null
          ? "not running"
          : `pid ${snapshot.daemon.pid} (${snapshot.daemon.alive ? "alive" : "dead"})`
      }`,
    );
    lines.push(
      `Internal servers: ${snapshot.internalServers
        .map((s) => `${s.name} ${s.port ?? "—"}`)
        .join(", ")}`,
    );
    lines.push(`Sessions (${snapshot.sessions.length}):`);
    for (const session of snapshot.sessions) {
      lines.push(
        `  ${session.sessionId} ${session.alive ? "alive" : "dead"}${
          session.orphaned ? " orphaned" : ""
        }${session.cwd ? ` — ${session.cwd}` : ""}`,
      );
    }
    lines.push(`Ports (${snapshot.ports.length}):`);
    for (const port of snapshot.ports) {
      lines.push(
        `  ${port.port} ${port.processName} pid ${port.pid}${
          port.workspacePath ? ` — ${port.workspacePath}` : ""
        }`,
      );
    }
    return text(lines.join("\n"));
  },

  async cleanup_dead_processes(_args, http) {
    const result = (await http.post("/processes/cleanup-dead")) as {
      success: boolean;
    };
    return text(
      result.success
        ? "Dead sessions disposed."
        : "Could not reach the daemon to dispose dead sessions.",
    );
  },

  async kill_daemon(_args, http) {
    await http.post("/processes/kill-daemon");
    return text("Daemon killed.");
  },

  async kill_all_processes(_args, http) {
    await http.post("/processes/kill-all");
    return text("Killed all sessions, workspace ports, and the daemon.");
  },

  async restart_portless(_args, http) {
    await http.post("/processes/restart-portless");
    return text("Portless proxy restarted.");
  },

  // ── Ports ──

  async scan_ports(_args, http) {
    const ports = (await http.get("/ports")) as PortRow[];
    if (ports.length === 0) return text("No listening ports found.");
    return text(
      ports
        .map(
          (p) =>
            `${p.port} ${p.processName} pid ${p.pid}${
              p.workspacePath ? ` — ${p.workspacePath}` : ""
            }`,
        )
        .join("\n"),
    );
  },

  async kill_port(args, http) {
    await http.post("/ports/kill", { pid: args.pid });
    return text(`Killed pid ${String(args.pid)}.`);
  },

  // ── Preferences ──

  async get_preferences(_args, http) {
    const prefs = await http.get("/preferences");
    return text(JSON.stringify(prefs, null, 2));
  },

  async set_preference(args, http) {
    const key = args.key as string;
    const value = parsePreferenceValue(args.value as string);
    await http.post("/preferences", { key, value });
    return text(`${key} = ${JSON.stringify(value)}`);
  },

  // ── Theme ──

  async get_theme(_args, http) {
    const result = (await http.get("/theme")) as {
      name: string;
      theme: Record<string, unknown>;
    };
    const colors = Object.entries(result.theme)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `  ${k}: ${String(v)}`)
      .join("\n");
    return text(`${result.name}\n${colors}`);
  },

  async list_themes(_args, http) {
    const all = (await http.get("/theme/all")) as Record<
      string,
      { background?: string }
    >;
    const names = Object.keys(all).sort();
    if (names.length === 0) return text("No themes found.");
    return text(
      names
        .map((name) => `${name} ${all[name]?.background ?? ""}`.trim())
        .join("\n"),
    );
  },

  async set_theme(args, http) {
    const result = (await http.post("/theme", { name: args.name })) as {
      name: string;
    };
    return text(`Theme set to ${result.name}.`);
  },

  // ── Stats ──

  async get_stats(_args, http) {
    const stats = await http.get("/stats");
    return text(JSON.stringify(stats, null, 2));
  },

  async reset_stats(_args, http) {
    await http.del("/stats");
    return text("Usage stats reset.");
  },

  // ── Remote control ──

  async remote_control_status(_args, http) {
    const status = (await http.get(
      "/remote-control",
    )) as RemoteControlStatusRow;
    return text(formatRemoteStatus(status));
  },

  async set_remote_control_enabled(args, http) {
    const status = (await http.post("/remote-control/enabled", {
      enabled: args.enabled,
    })) as RemoteControlStatusRow;
    return text(formatRemoteStatus(status));
  },

  async start_tunnel(args, http) {
    const body: Record<string, unknown> = {};
    if (args.kind !== undefined) body.kind = args.kind;
    const status = (await http.post(
      "/remote-control/tunnel/start",
      body,
    )) as RemoteControlStatusRow;
    return text(formatRemoteStatus(status));
  },

  async stop_tunnel(_args, http) {
    const status = (await http.post(
      "/remote-control/tunnel/stop",
    )) as RemoteControlStatusRow;
    return text(formatRemoteStatus(status));
  },

  // ── Shell ──

  async open_in_editor(args, http) {
    const dirPath = await resolveWorkspacePath(
      http,
      args.path as string | undefined,
    );
    const result = (await http.post("/shell/open-in-editor", {
      path: dirPath,
    })) as { ok: boolean; error: string | null };
    return text(
      result.ok
        ? `Opened ${dirPath}.`
        : `Could not open ${dirPath}: ${result.error}`,
    );
  },

  async open_external(args, http) {
    await http.post("/shell/open-external", { url: args.url });
    return text(`Opened ${args.url as string}.`);
  },

  // ── Windows ──

  async list_windows(_args, http) {
    const windows = (await http.get("/windows")) as WindowRow[];
    if (windows.length === 0) return text("No Manor windows are open.");
    return text(
      windows
        .map(
          (w) =>
            `${w.id}: ${w.bounds.width}x${w.bounds.height} at (${w.bounds.x}, ${w.bounds.y})`,
        )
        .join("\n"),
    );
  },

  // ── Updater ──

  async check_for_updates(_args, http) {
    await http.post("/updater/check");
    return text("Update check started; Manor reports the result in its UI.");
  },

  async quit_and_install(_args, http) {
    await http.post("/updater/quit-and-install");
    return text("Manor is quitting to install the update.");
  },

  // ── Integrations ──

  async start_linear_issue(args, http) {
    const id = args.issueId as string;
    await http.post(`/linear/issues/${encodeURIComponent(id)}/start`);
    return text(`Started ${id}.`);
  },

  async close_linear_issue(args, http) {
    const id = args.issueId as string;
    await http.post(`/linear/issues/${encodeURIComponent(id)}/close`);
    return text(`Closed ${id}.`);
  },

  async github_status(_args, http) {
    const status = (await http.get("/github/status")) as {
      installed: boolean;
      authenticated: boolean;
      username?: string;
    };
    if (!status.installed) return text("gh is not installed.");
    if (!status.authenticated)
      return text("gh is installed but not authenticated.");
    return text(
      `gh is authenticated as ${status.username ?? "an unknown user"}.`,
    );
  },

  async create_github_issue(args, http) {
    const projectId = await resolveProjectId(
      http,
      args.projectId as string | undefined,
    );
    const body: Record<string, unknown> = { title: args.title };
    if (args.body !== undefined) body.body = args.body;
    if (args.labels !== undefined) body.labels = args.labels;
    const created = (await http.post(
      `/projects/${encodeURIComponent(projectId)}/issues`,
      body,
    )) as { url: string };
    return text(created.url);
  },
};

export const systemModule: ToolModule = { tools, handlers };
