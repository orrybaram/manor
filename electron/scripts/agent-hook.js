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
  if (argv && argv.length >= 3 && typeof argv[2] === "string" && argv[2].length > 0) {
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
 * Resolve the hook port: prefer ~/.manor/hook-port (always fresh),
 * fall back to MANOR_HOOK_PORT env var.
 *
 * Keep in sync with hookPortFile() in electron/paths.ts.
 */
function resolvePort(env, homeDir) {
  const portFile = path.join(homeDir, ".manor", "hook-port");
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    if (raw) {
      const n = parseInt(raw, 10);
      if (!isNaN(n) && n > 0) return n;
    }
  } catch {
    // File missing or unreadable — fall through to env.
  }
  const envPort = env.MANOR_HOOK_PORT;
  if (envPort) {
    const n = parseInt(envPort, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

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
  if (!paneId) {
    // Hook fired outside a Manor-managed pane — nothing to do.
    return;
  }

  const port = resolvePort(env, homeDir);
  if (!port) {
    stderr.write("[manor-hook] no hook port available (no port file, no env)\n");
    return;
  }

  const eventType =
    typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
  if (!eventType) return;

  const sessionId =
    typeof payload.session_id === "string" ? payload.session_id : null;
  const toolUseId =
    typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
  const kind = env.MANOR_AGENT_KIND || "claude";

  const url = buildUrl(port, { paneId, eventType, kind, sessionId, toolUseId });
  if (!url) return;

  try {
    await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
  } catch (err) {
    stderr.write(`[manor-hook] request failed: ${String(err)}\n`);
  }
}

module.exports = { main, readInput, resolvePort, buildUrl };

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
