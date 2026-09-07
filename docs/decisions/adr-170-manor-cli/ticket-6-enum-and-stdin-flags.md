---
title: Enum validation and stdin/file flag values in the CLI parser
status: in-progress
priority: medium
assignee: sonnet
blocked_by: [2]
---

# Enum validation and stdin/file flag values in the CLI parser

Two follow-ups from ticket 2, both confined to `electron/mcp/cli.ts`.

1. **Enum flags.** Six schema properties carry `enum: [...]` (`source`, `direction`, `position`, `contentType`, `status`). Add `enum?: string[]` to `PropSchema`. In `parseArgs`, reject a value not in the enum with a usage error naming the allowed values. In `renderCommandHelp`, render the label as `--flag <a|b|c>` instead of `<string>`.
2. **Stdin and file values.** For any non-boolean flag, a value of exactly `-` reads all of stdin (UTF-8) and `@<path>` reads that file (relative to cwd). Implement via an injectable `readValueSource` so tests do not touch real stdin: extend `CliIo` with an optional `stdin?: { read(): string }` (the entry passes `{ read: () => fs.readFileSync(0, "utf-8") }`). A missing file is a usage error. Mention the convention in `renderGlobalHelp` under Usage as one line: `Flag values: - reads stdin, @file reads a file.`

## Tests (`electron/mcp/cli.test.ts`)
- `split-pane --direction diagonal` → exit 2, stderr lists `horizontal, vertical`; valid value passes through.
- `split-pane --help` shows `--direction <horizontal|vertical>`.
- `execute-js --code -` with a fake stdin reads the code; `--code @file` reads a temp file; `@missing` → exit 2.

## Files to touch
- `electron/mcp/cli.ts`
- `electron/mcp/cli.test.ts`
- `electron/manor-cli.ts` — pass the stdin reader
- `docs/AGENT-SYSTEM.md` §10.4 — one sentence on `-`/`@file`
