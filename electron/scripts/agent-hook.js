#!/usr/bin/env node
/**
 * Manor agent hook — Node implementation.
 *
 * Replaces the brittle bash + grep extractor with proper JSON parsing.
 * Invoked by Claude Code (and other agent CLIs) via their hook system,
 * usually through a one-line bash wrapper that exec's `node agent-hook.js`.
 *
 * Reads the hook payload from stdin (or argv[2] for legacy single-arg
 * invocation), parses it, and issues a fire-and-forget GET to the Manor
 * hook server. Any failure is logged to stderr and exits 0 — we never
 * want to fail an agent's hook chain.
 *
 * This file ships as plain JS (no TS) so it can be copied verbatim to
 * ~/.manor/hooks/ at runtime and executed by the user's local Node.
 */

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/**
 * Read JSON payload from argv[2] if present, otherwise drain stdin.
 * Returns the raw string (possibly empty).
 */
function readInput(argv, stdin) {
  if (
    argv &&
    argv.length >= 3 &&
    typeof argv[2] === "string" &&
    argv[2].length > 0
  ) {
    return Promise.resolve(argv[2]);
  }
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stdin.setEncoding("utf-8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", finish);
    stdin.on("error", finish);
    // If stdin is a TTY (or otherwise nothing is piped), `end` may
    // never fire. Resolve immediately with whatever we have.
    if (stdin.isTTY) finish();
  });
}

/**
 * Header carrying the hook listener's token. Keep in sync with
 * HOOK_TOKEN_HEADER in electron/terminal-host/hook-listener.ts.
 */
const HOOK_TOKEN_HEADER = "x-manor-hook-token";

/**
 * Read a hook port file: the port on the first line and, for a remote
 * daemon's listener, its token on the second. Manor desktop's file holds
 * just the port. Returns null if the file is missing or has no valid port.
 */
function readPortFile(portFile) {
  let raw;
  try {
    raw = fs.readFileSync(portFile, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const first = (lines[0] || "").trim();
  if (!first) return null;
  const n = parseInt(first, 10);
  if (isNaN(n) || n <= 0) return null;
  const token = (lines[1] || "").trim();
  return { port: n, token: token || null };
}

/**
 * Resolve where to send the hook: the port file named by
 * MANOR_HOOK_PORT_FILE (set in a remote Manor daemon's panes), else
 * ~/.manor/hook-port (Manor desktop's, always fresh), falling back to the
 * MANOR_HOOK_PORT env var. Returns `{ port, token }` (token null when the
 * listener wants none) or null.
 *
 * Keep in sync with hookPortFile() / remoteHookPortFile() in electron/paths.ts.
 */
function resolveHookTarget(env, homeDir) {
  const portFile =
    env.MANOR_HOOK_PORT_FILE || path.join(homeDir, ".manor", "hook-port");
  const fromFile = readPortFile(portFile);
  if (fromFile) return fromFile;
  const envPort = env.MANOR_HOOK_PORT;
  if (envPort) {
    const n = parseInt(envPort, 10);
    if (!isNaN(n) && n > 0) return { port: n, token: null };
  }
  return null;
}

/** The port half of `resolveHookTarget`. */
function resolvePort(env, homeDir) {
  const target = resolveHookTarget(env, homeDir);
  return target ? target.port : null;
}

/**
 * Extract a notification kind discriminator from the payload.
 *
 * Claude Code's Notification hook payload may carry a `notification`
 * sub-object that identifies the reason for the notification. Known shapes
 * observed in the wild:
 *   { notification: { type: "permission_prompt", ... } }
 *   { notification: { kind: "permission_prompt", ... } }
 *
 * We extract whichever string field is present (type > kind > category)
 * and forward it so the hook server can decide whether to flip status.
 * If no discriminator is present we return null and the server falls back
 * to treating the notification as permission-style (preserving legacy
 * behaviour for old Claude Code versions that don't send the field).
 *
 * @param {unknown} payload - Parsed JSON payload from the hook.
 * @returns {string|null}
 */
function extractNotificationKind(payload) {
  if (!payload || typeof payload !== "object") return null;
  const notification = /** @type {Record<string,unknown>} */ (payload)
    .notification;
  if (!notification || typeof notification !== "object") return null;
  const n = /** @type {Record<string,unknown>} */ (notification);
  for (const key of ["type", "kind", "category"]) {
    if (typeof n[key] === "string" && n[key]) return n[key];
  }
  return null;
}

/**
 * SessionStart hint advertising the `manor` CLI, printed to stdout so
 * Claude Code folds it into the session's additional context. Only ever
 * emitted for Claude Code's SessionStart event — other agent kinds and
 * other events have different (or no) hook stdout semantics.
 */
const SESSION_START_HINT = {
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      "This terminal runs inside Manor. The `manor` CLI is on PATH: run `manor --help` for commands that manage projects, workspaces, panes, agents, and browser panes. Prefer it over the mcp__manor__* tools; they do the same thing but load a large tool roster into context. To fan a backlog of GitHub issues out to parallel agents in one shot, use `manor batch-create-workspaces --issues 1,2,3`; it creates a workspace per issue and launches an agent in each. Pass `--prompt-template` to override the default per-issue prompt. Verify launches with `manor list-agents` (a launch with no pane did not happen); don't fan out more than 4 agents at once without confirming with the user.",
  },
};

/**
 * Build the URL with whichever fields are present.
 * Returns null if required fields (paneId, eventType) are missing.
 */
function buildUrl(port, params) {
  if (!params.paneId || !params.eventType) return null;
  const url = new URL(`http://127.0.0.1:${port}/hook/event`);
  url.searchParams.set("paneId", params.paneId);
  url.searchParams.set("eventType", params.eventType);
  url.searchParams.set("kind", params.kind || "claude");
  if (params.sessionId) url.searchParams.set("sessionId", params.sessionId);
  if (params.toolUseId) url.searchParams.set("toolUseId", params.toolUseId);
  if (params.notificationKind)
    url.searchParams.set("notificationKind", params.notificationKind);
  return url.toString();
}

/**
 * Main entry. Pure: takes its dependencies as arguments so tests can
 * substitute fakes (stdin, fetch, env, homeDir).
 *
 * Always resolves; never throws. Errors are logged to stderr.
 */
async function main(opts) {
  const argv = opts.argv || process.argv;
  const stdin = opts.stdin || process.stdin;
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();
  const fetchFn = opts.fetch || globalThis.fetch;
  const stderr = opts.stderr || process.stderr;
  const stdout = opts.stdout || process.stdout;

  let raw;
  try {
    raw = await readInput(argv, stdin);
  } catch (err) {
    stderr.write(`[manor-hook] failed to read input: ${String(err)}\n`);
    return;
  }

  if (!raw || !raw.trim()) {
    // No payload — silently exit. Bash version did the same.
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    stderr.write(`[manor-hook] invalid JSON payload: ${String(err)}\n`);
    return;
  }

  const paneId = env.MANOR_PANE_ID;
  const eventType =
    typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : null;
  const kind = env.MANOR_AGENT_KIND || "claude";

  try {
    if (!paneId) {
      // Hook fired outside a Manor-managed pane — nothing to do.
      return;
    }

    const target = resolveHookTarget(env, homeDir);
    if (!target) {
      stderr.write(
        "[manor-hook] no hook port available (no port file, no env)\n",
      );
      return;
    }

    if (!eventType) return;

    const sessionId =
      typeof payload.session_id === "string" ? payload.session_id : null;
    const toolUseId =
      typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;

    // For Notification events, extract the kind discriminator so the server can
    // decide whether to flip status (only permission-style notifications should).
    const notificationKind =
      eventType === "Notification" ? extractNotificationKind(payload) : null;

    const url = buildUrl(target.port, {
      paneId,
      eventType,
      kind,
      sessionId,
      toolUseId,
      notificationKind,
    });
    if (!url) return;

    try {
      await fetchFn(url, {
        method: "GET",
        ...(target.token
          ? { headers: { [HOOK_TOKEN_HEADER]: target.token } }
          : {}),
        signal: AbortSignal.timeout(2000),
      });
    } catch (err) {
      stderr.write(`[manor-hook] request failed: ${String(err)}\n`);
    }
  } finally {
    // Advertise the `manor` CLI to Claude Code at session start. This runs
    // regardless of whether forwarding above succeeded, failed, or was
    // skipped, so the hint is never lost to an unrelated failure.
    if (paneId && eventType === "SessionStart" && kind === "claude") {
      stdout.write(`${JSON.stringify(SESSION_START_HINT)}\n`);
    }
  }
}

module.exports = {
  main,
  readInput,
  resolvePort,
  resolveHookTarget,
  buildUrl,
  extractNotificationKind,
};

// Run as a CLI when invoked directly (not when imported by tests).
if (require.main === module) {
  main({}).then(
    () => process.exit(0),
    (err) => {
      // Should be unreachable — main() catches everything — but guard
      // anyway so we never fail the agent's hook chain.
      process.stderr.write(`[manor-hook] unexpected: ${String(err)}\n`);
      process.exit(0);
    },
  );
}
