---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-170: `manor` CLI — a shell command generated from the MCP tool modules

## Context

Agents drive Manor through the `manor` MCP server (`electron/mcp-webview-server.ts`).
It exposes 41 tools across five modules (`electron/mcp/tools-{webview,projects,agents,panes,sessions}.ts`),
each a thin handler over the control HTTP server (`electron/routes/*`, `electron/webview-server.ts`).

The MCP transport has a fixed cost that scales with the tool count, not with usage:

- **Standing context.** The tool descriptions alone are ~10.5k characters; with the
  JSON input schemas the roster is ~4–6k tokens loaded into every agent session,
  whether or not any tool is used. Claude Code now defers MCP schemas until first use,
  which softens but does not remove the cost, and other agents (Codex, Pi, plain shell
  loops) load the full roster every turn.
- **Per-agent registration.** Every connector in `electron/agent-connectors.ts` carries
  a `registerMcp` implementation that rewrites that agent's config file (JSON for
  Claude, TOML for Codex). Each new agent kind means another config-format adapter.
- **No composition.** MCP results always land in the agent's context in full. A shell
  command can be piped through `grep`, `jq`, `head`, redirected to a file, or run
  inside a script, and this repo's `rtk` hook already filters bash output.

A CLI already half-exists. ADR-053 shipped `~/.manor/bin/manor-webview`
(`electron/webview-cli-script.ts`), a 353-line bash script that wraps only the
webview routes with `curl` and parses JSON with `grep`. It was framed as "the universal
interface — any CLI agent that can run shell commands gets webview access", but
ADR-110/144/145/148/149/150 grew the MCP side instead and the bash script never learned
about projects, agents, panes, or sessions. It duplicates pane resolution and error
formatting that `electron/mcp/tools-webview.ts` already implements in TypeScript, and
nothing puts `~/.manor/bin` on `PATH`, so it is only reachable by absolute path.

Two interfaces that must be kept in sync by hand will drift. One of them must be
derived from the other.

## Decision

Ship a single `manor` command, implemented in Node and **generated from the existing
`ToolModule` definitions** so the CLI and MCP surfaces cannot diverge. Keep the MCP
server registered; this ADR adds an interface, it does not remove one.

### 1. Share the HTTP client

Extract `candidatePorts` / `request` / `httpGet` / `httpPost` / `httpDelete` from
`electron/mcp-webview-server.ts` into `electron/mcp/http-client.ts` exporting
`createHttp(): Http`. Port discovery (`MANOR_WEBVIEW_PORT` env, then
`~/.manor/webview-server-port`) and the "is Manor running?" error stay identical.
`mcp-webview-server.ts` becomes MCP-transport-only.

### 2. Generate the command surface from `ToolDef`

New `electron/mcp/cli.ts` exporting `runCli(argv, http, io): Promise<number>`
(exit code; `io` is `{ stdout, stderr }` so tests can capture output). It walks the same
`modules` array the MCP entry composes and derives, per tool:

| Tool definition | CLI |
|---|---|
| `name: "list_projects"` | subcommand `list-projects` (underscore → hyphen) |
| `inputSchema.properties.projectId` | flag `--project-id` (camel → kebab; camelCase also accepted) |
| `type: "number"` | coerced with `Number()`, usage error if `NaN` |
| `type: "boolean"` | `--flag` / `--no-flag` |
| `type: "array"` | repeatable flag |
| `inputSchema.required` | usage error listing missing flags |
| `description` | `manor <cmd> --help` prints it in full, plus one line per flag |

`manor --help` prints every command grouped by module with only the **first sentence**
of each description, so an agent that reads help once spends a fraction of what the MCP
roster costs. `manor <cmd> --help` prints the full description and flags.

The dispatch is the MCP `handleTool` path: look up `handlers[toolName]`, call it with the
parsed args and the shared `Http`. Output rendering:

- `content[].type === "text"` → written to stdout verbatim. Same formatting agents
  already see through MCP (`formatProject`, pane listings, etc.).
- `content[].type === "image"` → PNG written to `--path` if the handler did not already
  save it, otherwise to `os.tmpdir()/manor-<tool>-<timestamp>.png`; the path is printed.
  Base64 never hits stdout.
- Handler throw → message on stderr, exit `1`. Usage errors exit `2`. Success exits `0`.

Two escape hatches that the tool modules do not cover:

- `manor api <METHOD> <path> [--body '<json>']` → raw request to the control server,
  raw JSON on stdout. This is the `jq`-friendly path and lets agents reach a route
  before it has a tool.
- `manor --json <cmd>` is **out of scope** for this ADR. Handlers return pre-formatted
  text; a structured mode would need every handler to return data + formatter. Revisit
  once usage shows a need.

### 3. Standalone entry, bundled like the MCP server

`electron/manor-cli.ts` is a ~20-line entry: `createHttp()`, `runCli(process.argv.slice(2), http, process)`, `process.exit(code)`.
It gets a Vite `lib` entry in `vite.config.ts` (CJS, `dist-electron/manor-cli.js`,
`@modelcontextprotocol/sdk` external is unnecessary since the CLI never imports it), a
line in `package.json` `build.asarUnpack`, and a `knip.json` entry.

### 4. Install to `~/.manor/bin/manor` and put it on `PATH`

`electron/manor-cli-install.ts` replaces `electron/webview-cli-script.ts` and follows
the `ensureHookScript` pattern in `electron/agent-hooks.ts`:

- Copy the bundled `manor-cli.js` to `~/.manor/bin/manor.js` (dev fallback: run from
  source via the same try/catch as `ensureHookScript`). Copying rather than pointing a
  shim at `app.asar.unpacked` means the command survives app moves and updates.
- Write a two-line shim `~/.manor/bin/manor`: `exec node "$HOME/.manor/bin/manor.js" "$@"`.
  `node` on `PATH` is already a requirement of the MCP registration (`command: "node"`).
- Delete the legacy `~/.manor/bin/manor-webview` if present, the same way
  `registerMcp` strips the `manor-webview` MCP entry.
- New `manorBinDir()` in `electron/paths.ts`.
- `electron/terminal-host/session.ts` prepends `manorBinDir()` to `PATH` in the spawn
  env alongside `MANOR_PANE_ID`, so every Manor terminal, and every agent launched in
  one, can type `manor` with no setup. Terminals outside Manor still have the MCP.

`manor` inherits `MANOR_PANE_ID` from the pane's shell, so `current_workspace`,
`list_panes`-style defaults, and `/context` resolution behave exactly as they do over MCP.

### 5. Documentation

Update `docs/AGENT-SYSTEM.md` §10.4 and the README with the CLI, its generation rule,
and the guidance that agents running inside Manor should prefer `manor` over the MCP
tools for token cost. ADR-053's ticket-6 description of `manor-webview` is left as
history.

### Considered and rejected

- **Extend the bash script.** Would triple its size and duplicate every handler's
  formatting, pane/project resolution, and error contract in `grep`. Rejected: the point
  is one source of truth.
- **Hand-written commands (commander/yargs).** Nicer verbs (`manor projects list`), but
  a second table to keep in sync, plus a dependency. Rejected for now; a curated alias
  layer can be added on top of the generated surface later without moving the truth.
- **Drop the MCP server.** Premature. MCP still wins on typed args for multi-line
  `execute_js` code, on returning images inline, and on permission prompts that name
  the tool. Measure real sessions with MCP disabled before deciding; that is a
  follow-up ADR.

## Consequences

**Better**

- One definition drives both surfaces. Adding a tool to a `ToolModule` adds a
  subcommand for free; there is no CLI to forget to update.
- Standing context per session drops from the full tool roster to zero; cost is paid
  only on `manor --help` or a specific `--help`, and only once.
- Any agent, script, or human with a Manor terminal gets the full control surface with
  no connector work. New agent kinds need hooks only, not an MCP adapter.
- Output composes with `grep`/`jq`/redirection and is already filtered by the `rtk`
  bash hook.
- 353 lines of bash with hand-rolled JSON parsing are deleted.

**Worse / risks**

- Flag-based invocation is clunkier than MCP's typed objects for long values.
  `manor execute-js --code "$(cat snippet.js)"` works but is less ergonomic than passing
  the code as a tool argument. The `api` escape hatch with `--body` covers the rest.
- Screenshots become a file path rather than an inline image. Agents that want to
  *look* at the page should keep using the MCP tool; agents that want to save or diff
  should use the CLI.
- Requires `node` on the user's `PATH` from inside a Manor terminal. Already true for
  MCP; now it also gates the CLI.
- Prepending to `PATH` in the pane env is one more Manor-specific mutation of the
  shell environment. It is a single well-known directory and is documented.
- Agents must learn the command exists. Until a project's `CLAUDE.md` or the hook
  script mentions it, discoverability is worse than MCP's automatic tool listing.
  Follow-up: consider injecting a one-line hint at `SessionStart`.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
