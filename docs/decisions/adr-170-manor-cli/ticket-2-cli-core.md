---
title: CLI core — argv parser, help, and result printer generated from ToolDef
status: done
priority: critical
assignee: opus
blocked_by: []
---

# CLI core — argv parser, help, and result printer generated from ToolDef

Build `electron/mcp/cli.ts` exporting `runCli(argv: string[], http: Http, io: CliIo): Promise<number>`.
Everything the CLI knows about commands is derived from the `ToolDef` objects in the
`ToolModule`s; there is no hand-written command table.

```ts
export interface CliIo {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}
```

Import the module list from `electron/mcp/modules.ts` (create it if ticket 1 did not:
`export const modules = [webviewModule, projectsModule, agentsModule, panesModule, sessionsModule]`
in that order). Keep a `moduleLabel` next to each module for help grouping
(`webview`, `projects`, `agents`, `panes`, `sessions`).

## Naming rules

- Tool `list_projects` → subcommand `list-projects`. Implement `toCommandName(toolName)`
  and the inverse lookup by building a `Map<command, ToolDef>` once.
- Schema property `projectId` → flag `--project-id`. Implement `toFlagName(prop)`.
  Accept the camelCase form too (`--projectId`) so copy-pasted MCP args work.

## Parsing

Hand-roll it; no dependency. Rules:

- `--flag value` and `--flag=value` both work.
- `type: "boolean"` → `--flag` sets `true`, `--no-flag` sets `false`, no value consumed.
- `type: "number"` → `Number(value)`; `NaN` is a usage error naming the flag.
- `type: "array"` → repeatable; each occurrence pushes one element. If the schema's
  `items.type` is `number`, coerce each.
- Anything else (string, object) → the raw string. For `type: "object"` try
  `JSON.parse` and fall back to a usage error.
- Unknown flag for that command → usage error listing valid flags.
- After parsing, check `inputSchema.required`; list every missing flag in one usage error.
- `-h` / `--help` anywhere after the command name prints the command help and exits `0`.

## Help

- `manor` with no args or `manor --help`: usage line, then one section per module,
  each tool on one line as `  <command>  <first sentence of description>`. First sentence
  = text up to the first `. ` or end of string. Then the `api` escape hatch on its own line.
- `manor <cmd> --help`: full `description`, then a `Flags:` block with one line per
  property: `  --flag <type>   <property description>`, and `(required)` suffix where
  applicable.
- Unknown command → stderr `Unknown command: x. Run manor --help.`, exit `2`.

## Dispatch and output

- Look up `handlers[tool.name]` (merge handler maps the same way the MCP entry does) and
  call it with the parsed args and `http`.
- For each `content` item:
  - `type === "text"` → `io.stdout.write(text + "\n")`.
  - `type === "image"` → decode base64 to a Buffer; write to
    `path.join(os.tmpdir(), \`manor-${command}-${Date.now()}.png\`)`; print
    `Saved <path>`. Never write base64 to stdout. (When the caller passed `--path`, the
    `screenshot_webview` handler already returns text; nothing extra to do.)
- Handler throws → if `isConnectionError(err)` print
  `Cannot connect to Manor — is it running?`, else `err.message`; both to stderr; return `1`.
- Usage problems return `2`; success returns `0`. `runCli` must never call `process.exit`.

## `api` escape hatch

`manor api <GET|POST|DELETE> <path> [--body '<json>']` → call `http.get/post/del` and
print `JSON.stringify(result, null, 2)`. `--body` must parse as JSON or it is a usage error.
On `HttpError`, print `HTTP <status>: <rawBody>` to stderr and return `1`.

## Tests — `electron/mcp/cli.test.ts`

Use a fake `Http` (`vi.fn()` per method) and a capturing `CliIo`. Cover at least:

- `toCommandName` / `toFlagName` round trips for every tool and property in `modules`
  (iterate the real modules so a new tool with an odd name fails the test).
- `manor --help` lists every command exactly once and contains no full-stop-delimited
  second sentences.
- `manor get-project --project-id abc` calls `http.get("/projects/abc")` and prints the
  handler's text; the camelCase `--projectId abc` form does the same.
- Missing required flag → exit `2`, stderr names the flag, `http` never called.
- Number coercion and `NaN` usage error.
- Boolean `--no-` form.
- Image content is written to a `.png` under `os.tmpdir()` and stdout has the path only.
- Connection error → exit `1` with the "is it running?" message.
- `api POST /projects --body '{"path":"/x"}'` posts the parsed body and prints JSON.

## Files to touch
- `electron/mcp/cli.ts` — new; `runCli`, `toCommandName`, `toFlagName`, help rendering, parser, printer
- `electron/mcp/modules.ts` — new if absent; shared module list with labels
- `electron/mcp/cli.test.ts` — new
