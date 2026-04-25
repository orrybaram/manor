---
title: Replace bash hook with Node script for robust JSON parsing
status: todo
priority: high
assignee: opus
blocked_by: []
---

# Replace bash hook with Node script for robust JSON parsing

`electron/agent-hooks.ts:151-199` embeds a bash script that parses hook payloads with `grep -oE` against the JSON. Brittle: any escaped quote inside a string, nested object with the same key, or schema change silently breaks extraction. Errors are swallowed by `exit 0` and `curl ... > /dev/null 2>&1`.

See ADR-135 §"Change 5" for full reasoning.

## What to change

1. Add `electron/scripts/agent-hook.js` — a small Node script that:
   - Reads JSON from stdin (or `argv[2]` for the legacy single-arg invocation).
   - `JSON.parse`s it (errors → `console.error` to stderr, exit 0).
   - Resolves the port: prefer `~/.manor/hook-port` (read fresh), fall back to `process.env.MANOR_HOOK_PORT`.
   - Builds the URL: `http://127.0.0.1:${PORT}/hook/event?paneId=...&eventType=...&kind=...&sessionId=...&toolUseId=...`.
   - Issues a GET with a 2-second timeout (`AbortSignal.timeout(2000)`).
   - On any error: log to stderr, exit 0 (we never want to fail the agent's hook chain).
2. Replace `HOOK_SCRIPT` (the bash string) with a thin shim that just `exec`s `node agent-hook.js "$@"`. Keep the `.sh` wrapper for backward compat with already-registered hooks; the shim path is one line of bash.

   Alternative — point the connectors directly at `node /path/to/agent-hook.js`. Cleaner but breaks any user who still has the old bash path registered. Stick with the wrapper for now, deprecate later.
3. Update `ensureHookScript()` (`agent-hooks.ts:202-206`) to write **two** files: the bash wrapper and the JS script.
4. Path resolution: in production the scripts go to `~/.manor/manor-agent-hook.sh` and `~/.manor/manor-agent-hook.js`. In packaged builds, copy from `app.asar.unpacked` mirroring the MCP-server pattern at `agent-hooks.ts:212-214`.

## Files to touch

- `electron/agent-hooks.ts` — replace `HOOK_SCRIPT` content with a `node` shim; extend `ensureHookScript` to also write the JS file.
- `electron/scripts/agent-hook.js` — new file (or `.ts` compiled to `.js`; pick whichever fits the build).
- `electron/paths.ts` — add a path helper for the JS script alongside `hookScriptPath()`.

## Risks / fallbacks

- If `node` isn't on PATH where the agent runs, the wrapper fails. The agent hook chain logs to stderr and exits 0; agents continue running. Manor users always have Node installed (Electron is bundled), so PATH exposure is the only concern. Verify in the test plan.
- Per-hook latency rises from ~5 ms (bash+curl) to ~30-50 ms (node startup + http). Hook events are off the user's critical path; acceptable.

## Tests

Manual smoke (because hook payloads come from real agents):

1. Run `claude --resume` in a Manor pane; verify task lifecycle still drives correctly.
2. Force a hook payload with an embedded escaped quote (e.g. via a script that pipes a malformed JSON to the script directly); the bash version drops the event silently — the new version logs to stderr and the URL is built from the parsed value.

Add a unit test (in `electron/__tests__/agent-hook-script.test.ts` or similar) that imports the script as a module and runs its `main()` against a fake stdin + fake fetch, asserting the URL parameters.
