/**
 * Agent connector abstraction — encapsulates agent-specific integration details
 * (CLI commands, config paths, hook/MCP registration) behind a common interface.
 *
 * Each supported coding agent (Claude Code, Codex, etc.) implements this interface
 * so the rest of Manor can remain agent-agnostic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentKind } from "./terminal-host/types";

// ── Interface ──

export interface AgentConnector {
  /** Which agent kind this connector handles */
  readonly kind: AgentKind;

  /** Default CLI command for starting a new session */
  readonly defaultCommand: string;

  /**
   * Build a command to resume an existing session.
   * Returns null if the agent doesn't support session resume.
   */
  getResumeCommand(baseCommand: string, sessionId: string): string | null;

  /**
   * Build a command to start a new session with an initial prompt.
   * Returns null if the agent doesn't support inline prompts.
   */
  getPromptCommand(baseCommand: string, prompt: string): string;

  /**
   * Register lifecycle hooks in the agent's config so it calls back to Manor.
   * No-op if the agent doesn't support hooks.
   */
  registerHooks(hookScriptPath: string): void;

  /**
   * Register the Manor MCP server in the agent's config.
   * No-op if the agent doesn't support MCP.
   */
  registerMcp(mcpServerScriptPath: string): void;
}

// ── Claude Code Connector ──

const CLAUDE_HOOK_ENTRIES = [
  { event: "SessionStart", matcher: undefined },
  { event: "UserPromptSubmit", matcher: undefined },
  { event: "Stop", matcher: undefined },
  { event: "PostToolUse", matcher: "*" },
  { event: "PostToolUseFailure", matcher: "*" },
  { event: "PermissionRequest", matcher: "*" },
  { event: "PreToolUse", matcher: "*" },
  { event: "Notification", matcher: "permission_prompt" },
  { event: "StopFailure", matcher: undefined },
  { event: "SubagentStart", matcher: undefined },
  { event: "SubagentStop", matcher: undefined },
  { event: "SessionEnd", matcher: undefined },
];

export class ClaudeConnector implements AgentConnector {
  readonly kind: AgentKind = "claude";
  readonly defaultCommand = "claude --dangerously-skip-permissions";

  getResumeCommand(baseCommand: string, sessionId: string): string {
    // Extract the binary name (first token) — flags like --dangerously-skip-permissions
    // aren't needed for resume since the session already has its config.
    const binary = baseCommand.split(" ")[0] ?? "claude";
    return `${binary} --resume ${sessionId}`;
  }

  getPromptCommand(baseCommand: string, prompt: string): string {
    const escaped = prompt
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/!/g, "\\!");
    return `${baseCommand} "${escaped}"`;
  }

  registerHooks(hookScriptPath: string): void {
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

    for (const entry of CLAUDE_HOOK_ENTRIES) {
      const eventHooks = (hooks[entry.event] ?? []) as Array<{
        matcher?: string;
        hooks: Array<{ type: string; command: string }>;
      }>;

      const alreadyRegistered = eventHooks.some((h) =>
        h.hooks?.some((hh) => hh.command === hookScriptPath),
      );

      if (!alreadyRegistered) {
        const hookEntry: {
          matcher?: string;
          hooks: Array<{ type: string; command: string }>;
        } = {
          hooks: [{ type: "command", command: hookScriptPath }],
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
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    }
  }

  registerMcp(mcpServerScriptPath: string): void {
    const configPath = path.join(process.env.HOME || "/tmp", ".claude.json");

    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {
      // File doesn't exist or invalid JSON
    }

    const mcpServers = (config.mcpServers ?? {}) as Record<
      string,
      {
        type: string;
        command: string;
        args: string[];
        env: Record<string, string>;
      }
    >;

    const existing = mcpServers["manor-webview"];
    const needsUpdate =
      !existing ||
      existing.command !== "node" ||
      !existing.args ||
      existing.args[0] !== mcpServerScriptPath;

    if (needsUpdate) {
      mcpServers["manor-webview"] = {
        type: "stdio",
        command: "node",
        args: [mcpServerScriptPath],
        env: {},
      };
      config.mcpServers = mcpServers;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  }
}

// ── Codex CLI Connector ──

const CODEX_HOOK_ENTRIES = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse" },
  { event: "PostToolUse" },
  { event: "Stop" },
];

export class CodexConnector implements AgentConnector {
  readonly kind: AgentKind = "codex";
  readonly defaultCommand = "codex --yolo";

  getResumeCommand(baseCommand: string, _sessionId: string): string | null {
    // Extract the binary name (first token) — flags like --yolo aren't needed for resume.
    // Codex uses `codex resume --last` to resume the most recent session.
    const binary = baseCommand.split(" ")[0] ?? "codex";
    return `${binary} resume --last`;
  }

  getPromptCommand(baseCommand: string, prompt: string): string {
    const escaped = prompt
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/!/g, "\\!");
    return `${baseCommand} "${escaped}"`;
  }

  registerHooks(hookScriptPath: string): void {
    const hooksPath = path.join(
      process.env.HOME || "/tmp",
      ".codex",
      "hooks.json",
    );

    let hooksFile: Record<string, unknown> = {};
    try {
      hooksFile = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    } catch {
      // File doesn't exist or invalid JSON
    }

    const hooks = (hooksFile.hooks ?? {}) as Record<string, unknown[]>;
    let modified = false;

    for (const entry of CODEX_HOOK_ENTRIES) {
      const eventHooks = (hooks[entry.event] ?? []) as Array<{
        hooks: Array<{ type: string; command: string }>;
      }>;

      const alreadyRegistered = eventHooks.some((h) =>
        h.hooks?.some((hh) => hh.command === hookScriptPath),
      );

      if (!alreadyRegistered) {
        eventHooks.push({
          hooks: [{ type: "command", command: hookScriptPath }],
        });
        hooks[entry.event] = eventHooks;
        modified = true;
      }
    }

    if (modified) {
      hooksFile.hooks = hooks;
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify(hooksFile, null, 2) + "\n");
    }

    // Ensure the codex_hooks feature flag is enabled in ~/.codex/config.toml
    this._ensureCodexHooksFeatureFlag();
  }

  private _ensureCodexHooksFeatureFlag(): void {
    const configPath = path.join(
      process.env.HOME || "/tmp",
      ".codex",
      "config.toml",
    );

    let content = "";
    try {
      content = fs.readFileSync(configPath, "utf-8");
    } catch {
      // File doesn't exist — will create it
    }

    // Check if codex_hooks = true is already present anywhere in the file
    if (/codex_hooks\s*=\s*true/.test(content)) {
      return;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    // If [features] section exists, append the flag after it
    if (content.includes("[features]")) {
      const lines = content.split("\n");
      const featuresIndex = lines.findIndex((l) =>
        l.trim() === "[features]",
      );
      lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
      fs.writeFileSync(configPath, lines.join("\n"));
    } else {
      // Append a new [features] section at the end
      const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      fs.writeFileSync(
        configPath,
        content + separator + "\n[features]\ncodex_hooks = true\n",
      );
    }
  }

  registerMcp(mcpServerScriptPath: string): void {
    const configPath = path.join(
      process.env.HOME || "/tmp",
      ".codex",
      "config.toml",
    );

    let content = "";
    try {
      content = fs.readFileSync(configPath, "utf-8");
    } catch {
      // File doesn't exist — will create it
    }

    // Check if manor-webview MCP server is already registered
    if (content.includes("[mcp_servers.manor-webview]")) {
      return;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    const section = [
      `\n[mcp_servers.manor-webview]`,
      `type = "stdio"`,
      `command = "node"`,
      `args = [${JSON.stringify(mcpServerScriptPath)}]`,
      "",
    ].join("\n");

    fs.writeFileSync(configPath, content + separator + section);
  }
}

// ── Pi Connector ──

const PI_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

export class PiConnector implements AgentConnector {
  readonly kind: AgentKind = "pi";
  readonly defaultCommand = "pi";

  getResumeCommand(baseCommand: string, sessionId: string): string {
    const binary = baseCommand.split(" ")[0] ?? "pi";
    return `${binary} --session ${sessionId}`;
  }

  getPromptCommand(baseCommand: string, prompt: string): string {
    const escaped = prompt
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`")
      .replace(/!/g, "\\!");
    return `${baseCommand} "${escaped}"`;
  }

  registerHooks(hookScriptPath: string): void {
    // Pi uses extensions for hooks, not config files.
    // The manor-hooks extension is installed separately.
    // We create a simple shell hook script that pi's extension will call.
    const piHooksDir = path.join(
      process.env.HOME || "/tmp",
      ".pi",
      "agent",
      "extensions",
    );

    fs.mkdirSync(piHooksDir, { recursive: true });

    // Generate the pi extension that sends hooks to Manor
    const extensionContent = `/**
 * Manor hooks extension for pi — sends agent lifecycle events to Manor.
 * Auto-generated by Manor. Do not edit.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HOOK_PORT_FILE = process.env.HOME + "/.manor/hook-port";

async function sendHook(eventType: string, sessionId?: string): Promise<void> {
  const paneId = process.env.MANOR_PANE_ID;
  if (!paneId) return;

  let port: string | undefined;
  try {
    const fs = await import("node:fs");
    port = fs.readFileSync(HOOK_PORT_FILE, "utf-8").trim();
  } catch {
    port = process.env.MANOR_HOOK_PORT;
  }
  if (!port) return;

  const url = new URL("http://127.0.0.1/hook/event");
  url.port = port;
  url.searchParams.set("paneId", paneId);
  url.searchParams.set("eventType", eventType);
  url.searchParams.set("kind", "pi");
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  }

  try {
    await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Ignore errors — Manor might not be running
  }
}

// Track the last known session name to detect changes
let lastSessionName: string | null = null;

// Update terminal title with session name for Manor to detect
function updateTitle(pi: ExtensionAPI, ctx: { ui: { setTitle: (title: string) => void } }): void {
  const name = pi.getSessionName();
  if (name && name !== lastSessionName) {
    lastSessionName = name;
    // Set terminal title so Manor can pick it up
    ctx.ui.setTitle(name);
  }
}

export default function (pi: ExtensionAPI) {
  // Session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await sendHook("SessionStart", sessionId);
    // Set initial title if session has a name
    updateTitle(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await sendHook("SessionEnd", sessionId);
  });

  // Agent lifecycle
  pi.on("agent_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await sendHook("UserPromptSubmit", sessionId);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await sendHook("Stop", sessionId);
    // Check if session name changed (e.g., via /name command)
    updateTitle(pi, ctx);
  });

  // Tool execution
  pi.on("tool_execution_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await sendHook("PreToolUse", sessionId);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (event.isError) {
      await sendHook("PostToolUseFailure", sessionId);
    } else {
      await sendHook("PostToolUse", sessionId);
    }
  });
}
`;

    const extensionPath = path.join(piHooksDir, "manor-hooks.ts");
    
    // Only write if content changed or doesn't exist
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(extensionPath, "utf-8");
    } catch {
      // File doesn't exist
    }

    if (existingContent !== extensionContent) {
      fs.writeFileSync(extensionPath, extensionContent);
    }
  }

  registerMcp(mcpServerScriptPath: string): void {
    // Pi uses settings.json for MCP configuration
    const settingsPath = path.join(
      process.env.HOME || "/tmp",
      ".pi",
      "agent",
      "settings.json",
    );

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    } catch {
      // File doesn't exist or invalid JSON
    }

    // Pi doesn't have built-in MCP support — it's added via extensions.
    // For now, we skip MCP registration for pi.
    // Users can install an MCP extension package if needed.
  }
}

// ── Registry ──

const connectors: Map<AgentKind, AgentConnector> = new Map();

function ensureDefaults(): void {
  if (connectors.size === 0) {
    const claude = new ClaudeConnector();
    const codex = new CodexConnector();
    const pi = new PiConnector();
    connectors.set(claude.kind, claude);
    connectors.set(codex.kind, codex);
    connectors.set(pi.kind, pi);
  }
}

/** Get the connector for a specific agent kind */
export function getConnector(kind: AgentKind): AgentConnector {
  ensureDefaults();
  return connectors.get(kind) ?? connectors.get("claude")!;
}

/** Get the default connector (Claude) */
export function getDefaultConnector(): AgentConnector {
  ensureDefaults();
  return connectors.get("claude")!;
}

/** Get all registered connectors */
export function getAllConnectors(): AgentConnector[] {
  ensureDefaults();
  return Array.from(connectors.values());
}

/**
 * Detect which connector matches a given agent command string.
 * Falls back to the default (Claude) connector if no match.
 */
export function getConnectorForCommand(command: string): AgentConnector {
  ensureDefaults();
  const firstToken = command.split(" ")[0]?.toLowerCase() ?? "";
  for (const connector of connectors.values()) {
    if (firstToken.includes(connector.kind)) {
      return connector;
    }
  }
  return connectors.get("claude")!;
}
