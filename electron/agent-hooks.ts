/**
 * Agent hook server — receives lifecycle events from agent CLIs
 * (Claude Code, Codex, etc.) via their native hook systems.
 *
 * Architecture:
 * 1. On startup, registers hooks in ~/.claude/settings.json
 * 2. Starts an HTTP server on a random port
 * 3. PTY sessions get MANOR_HOOK_PORT env var so hooks can call back
 * 4. Hook script (curl) → HTTP server → IPC to renderer
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BrowserWindow } from "electron";

// Map hook event names to our status
import type { AgentStatus } from "./terminal-host/types";

type PaneStatus = AgentStatus;

export function mapEventToStatus(eventType: string): PaneStatus | null {
  switch (eventType) {
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "SubagentStop":
      return "thinking";
    case "PreToolUse":
    case "SubagentStart":
      return "working";
    case "PermissionRequest":
    case "Notification":
      return "requires_input";
    case "Stop":
      return "complete";
    case "StopFailure":
      return "error";
    case "SessionEnd":
      return "idle";
    default:
      return null;
  }
}

export class AgentHookServer {
  private server: http.Server | null = null;
  private port = 0;
  private mainWindow: BrowserWindow | null = null;

  get hookPort(): number {
    return this.port;
  }

  /** Start the HTTP server on a random port */
  async start(mainWindow: BrowserWindow): Promise<void> {
    this.mainWindow = mainWindow;

    this.server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1`);

      if (url.pathname !== "/hook/event") {
        res.writeHead(404);
        res.end();
        return;
      }

      const paneId = url.searchParams.get("paneId");
      const eventType = url.searchParams.get("eventType");

      if (!paneId || !eventType) {
        res.writeHead(400);
        res.end();
        return;
      }

      const status = mapEventToStatus(eventType);
      if (status) {
        this.sendToRenderer(paneId, status);
      }

      res.writeHead(200);
      res.end("ok");
    });

    return new Promise((resolve) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  private sendToRenderer(paneId: string, status: PaneStatus): void {
    if (
      !this.mainWindow ||
      this.mainWindow.isDestroyed() ||
      this.mainWindow.webContents.isDestroyed()
    )
      return;
    try {
      this.mainWindow.webContents.send(`pty-agent-status-${paneId}`, {
        kind: "claude",
        status,
        processName: "claude",
        since: Date.now(),
      });
    } catch {
      // Window disposed during reload
    }
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }
}

// ── Hook Registration ──

const MANOR_HOOK_ENTRIES = [
  {
    event: "UserPromptSubmit",
    matcher: undefined,
  },
  {
    event: "Stop",
    matcher: undefined,
  },
  {
    event: "PostToolUse",
    matcher: "*",
  },
  {
    event: "PostToolUseFailure",
    matcher: "*",
  },
  {
    event: "PermissionRequest",
    matcher: "*",
  },
  {
    event: "PreToolUse",
    matcher: "*",
  },
  {
    event: "Notification",
    matcher: "permission_prompt",
  },
  {
    event: "StopFailure",
    matcher: undefined,
  },
  {
    event: "SubagentStart",
    matcher: undefined,
  },
  {
    event: "SubagentStop",
    matcher: undefined,
  },
  {
    event: "SessionEnd",
    matcher: undefined,
  },
];

const HOOK_SCRIPT_PATH = path.join(
  process.env.HOME || "/tmp",
  ".manor",
  "hooks",
  "notify.sh",
);

const HOOK_SCRIPT = `#!/bin/bash
# Manor agent hook — notifies the app of agent lifecycle events.
# Called by Claude Code (and other agent CLIs) via their hook system.

# Read event JSON from stdin or first argument
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

# Extract event type
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
[ -z "$EVENT_TYPE" ] && exit 0
[ -z "$MANOR_PANE_ID" ] && exit 0
[ -z "$MANOR_HOOK_PORT" ] && exit 0

# Notify the app
curl -sG "http://127.0.0.1:\${MANOR_HOOK_PORT}/hook/event" \\
  --connect-timeout 1 --max-time 2 \\
  --data-urlencode "paneId=$MANOR_PANE_ID" \\
  --data-urlencode "eventType=$EVENT_TYPE" \\
  > /dev/null 2>&1

exit 0
`;

/** Ensure the hook script exists on disk */
export function ensureHookScript(): void {
  const dir = path.dirname(HOOK_SCRIPT_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });
}

/** Register Manor hooks in ~/.claude/settings.json */
export function registerClaudeHooks(): void {
  const settingsPath = path.join(
    process.env.HOME || "/tmp",
    ".claude",
    "settings.json",
  );

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch {
    // File doesn't exist or invalid JSON
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let modified = false;

  for (const entry of MANOR_HOOK_ENTRIES) {
    const eventHooks = (hooks[entry.event] ?? []) as Array<{
      matcher?: string;
      hooks: Array<{ type: string; command: string }>;
    }>;

    // Check if our hook is already registered
    const alreadyRegistered = eventHooks.some((h) =>
      h.hooks?.some((hh) => hh.command === HOOK_SCRIPT_PATH),
    );

    if (!alreadyRegistered) {
      const hookEntry: {
        matcher?: string;
        hooks: Array<{ type: string; command: string }>;
      } = {
        hooks: [{ type: "command", command: HOOK_SCRIPT_PATH }],
      };
      if (entry.matcher !== undefined) {
        hookEntry.matcher = entry.matcher;
      }
      eventHooks.push(hookEntry);
      hooks[entry.event] = eventHooks;
      modified = true;
    }
  }

  if (modified) {
    settings.hooks = hooks;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }
}
