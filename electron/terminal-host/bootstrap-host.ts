/**
 * Host bootstrap — set a machine up so Manor shells and agent CLIs on it are
 * wired for shell integration and agent hooks:
 *
 *   1. the generated ZDOTDIR every Manor shell starts in (`ShellManager`),
 *   2. the hook scripts agents call (`~/.manor/hooks/notify.{sh,js}`),
 *   3. hook (and optionally MCP) registration in every agent connector's config.
 *
 * Shared by Electron main at startup (the laptop) and by the terminal-host
 * daemon's `bootstrap` control request (ADR-160 ticket 10), which runs it
 * against the daemon's own filesystem on a remote host.
 *
 * This module must stay Electron-free — the daemon bundle imports it, and on a
 * remote box there is no Electron to import. Do not import `electron` here or
 * from anything it imports (see electron/paths.ts for the same rule).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { getAllConnectors } from "../agent-connectors";
import { hookScriptPath, hookScriptJsPath } from "../paths";
import { ShellManager } from "../shell";
import type { AgentKind } from "./types";

/**
 * Bash wrapper that exec's the Node script with stdin and any args
 * forwarded. Two reasons we keep a wrapper rather than registering
 * `node /path/...` directly with the agent CLIs:
 *   1. Backward compat: existing user configs already point at .sh.
 *   2. Lets us evolve the JS path/argv without rewriting agent configs.
 */
const HOOK_SCRIPT = `#!/bin/bash
# Manor agent hook — thin shim that delegates to the Node implementation.
# The real logic lives in notify.js next to this file.
exec node "$(dirname "$0")/notify.js" "$@"
`;

/**
 * Path of a file shipped next to the running bundle. Every bundle that
 * imports this module (main.js, terminal-host-index.js) lands in the same
 * directory as agent-hook.js and mcp-webview-server.js — dist-electron/
 * locally, the `manor-host` package directory on a remote. In packaged
 * builds the asar archive isn't readable by plain Node, so point at the
 * copy electron-builder's asarUnpack extracts.
 */
function bundledFilePath(name: string): string {
  return path.join(__dirname, name).replace("app.asar", "app.asar.unpacked");
}

/**
 * The agent-hook.js source. In unit tests this module runs from source
 * (vitest loads it directly) and there is no bundle next to it; fall back
 * to the source under electron/scripts/.
 */
function readAgentHookJs(): string {
  const candidates = [
    bundledFilePath("agent-hook.js"),
    path.join(__dirname, "..", "scripts", "agent-hook.js"),
  ];
  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return fs.readFileSync(candidate, "utf-8");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Ensure both hook scripts exist on disk: the bash wrapper agents
 * register against, and the Node script that does the real work.
 */
export function ensureHookScript(): void {
  const scriptPath = hookScriptPath();
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 });
  fs.writeFileSync(hookScriptJsPath(), readAgentHookJs(), { mode: 0o755 });
}

export interface RegisterAgentsOptions {
  /**
   * The MCP webview server script to register with each agent. Defaults to
   * the one shipped next to this bundle; `null` skips MCP registration (a
   * remote host has no webview server to talk to).
   */
  mcpServerScriptPath?: string | null;
}

/**
 * Register hooks (and MCP, unless disabled) for all known agent connectors.
 * Returns the kinds registered, in connector order.
 */
export function registerAllAgents(opts: RegisterAgentsOptions = {}): AgentKind[] {
  const mcpServerScriptPath =
    opts.mcpServerScriptPath === undefined
      ? bundledFilePath("mcp-webview-server.js")
      : opts.mcpServerScriptPath;
  const scriptPath = hookScriptPath();

  const registered: AgentKind[] = [];
  for (const connector of getAllConnectors()) {
    connector.registerHooks(scriptPath);
    if (mcpServerScriptPath !== null) {
      connector.registerMcp(mcpServerScriptPath);
    }
    registered.push(connector.kind);
  }
  return registered;
}

export interface BootstrapHostResult {
  zdotdir: string;
  /** Agent connectors whose hooks were registered. */
  agents: AgentKind[];
}

/**
 * Run the full host bootstrap: zdotdir, hook scripts, agent registration.
 * Throws on the first failure, as startup always has.
 */
export function bootstrapHost(opts: RegisterAgentsOptions = {}): BootstrapHostResult {
  const zdotdir = ShellManager.setupZdotdir();
  ensureHookScript();
  const agents = registerAllAgents(opts);
  return { zdotdir, agents };
}
