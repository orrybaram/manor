---
title: Standalone manor-cli entry, Vite bundle, knip and asarUnpack wiring
status: todo
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# Standalone manor-cli entry, Vite bundle, knip and asarUnpack wiring

Give the CLI a runnable entry point built the same way as `mcp-webview-server.js`.

## Implementation

1. `electron/manor-cli.ts`:
   ```ts
   import { createHttp } from "./mcp/http-client";
   import { runCli } from "./mcp/cli";

   runCli(process.argv.slice(2), createHttp(), process)
     .then((code) => process.exit(code))
     .catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
   ```
   `process` satisfies `CliIo` because `process.stdout.write` / `process.stderr.write` exist.
2. `vite.config.ts`: add a lib entry next to the MCP one — `entry: "electron/manor-cli.ts"`,
   `outDir: "dist-electron"`, `format: "cjs"`, `entryFileNames: "manor-cli.js"`. No
   `external` needed; verify the bundle does not pull in `@modelcontextprotocol/sdk`
   (grep the output).
3. `package.json` → `build.asarUnpack`: add `"dist-electron/manor-cli.js"`.
4. `knip.json` → `entry`: add `"electron/manor-cli.ts"`.
5. `pnpm build`, then smoke it by hand with Manor running:
   ```
   node dist-electron/manor-cli.js --help
   node dist-electron/manor-cli.js list-projects
   node dist-electron/manor-cli.js api GET /projects | head -c 200
   ```
   Record the three outputs (trimmed) in the commit message body.
6. `pnpm test` (includes `knip:ci`) must pass.

## Files to touch
- `electron/manor-cli.ts` — new entry
- `vite.config.ts` — new lib entry
- `package.json` — `asarUnpack` line
- `knip.json` — `entry` line
