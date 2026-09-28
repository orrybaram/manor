---
title: Add a writeFile control request to the terminal-host daemon
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Add a writeFile control request to the terminal-host daemon

See ADR-187 §1. Mirror the existing `readFile` request end to end.

- Request: `{ type: "writeFile"; path: string; base64: string }`. Success reply: `{ type: "fileWritten" }`. Document both with JSDoc in the style of neighboring entries.
- Add to `ResponseMap` (`writeFile: Reply<"fileWritten">`) and `REPLY_TYPES` (`writeFile: ["fileWritten"]`).
- Daemon handler (`index.ts`, next to `case "readFile"`): `Buffer.from(base64, "base64")`. If the result is over `MAX_WRITE_FILE_BYTES = 20 * 1024 * 1024`, throw. Otherwise `mkdir(dirname, { recursive: true })`, write to `${path}.${process.pid}.${random}.tmp` in the same directory, then `rename` it to `path`, removing the temp file on failure. On error reply `{ type: "error", message: \`writeFile failed: ${errorMessage(err)}\` }`.
- `control-queue.ts`: add `"writeFile"` to `UNSERIALIZED_REQUEST_TYPES` and update the header comment, which names exec/readFile.
- `rpc-channel.ts`: widen `ConcurrentRequest` to include `writeFile`.
- `client.ts`: `async writeFile(filePath: string, data: Buffer): Promise<void>` via `this.rpc.callConcurrent(..., WRITE_FILE_TIMEOUT_MS)` with `WRITE_FILE_TIMEOUT_MS = 60_000`. Call `ensureConnected()` first, like `readFile`.
- Do NOT bump `TERMINAL_HOST_PROTOCOL`.
- Tests: add daemon handler coverage next to the existing readFile tests (write, then read back; parent directory created; oversize rejected), and a control-queue test showing writeFile is unserialized if such tests exist for readFile.

## Files to touch
- `electron/terminal-host/types.ts` — request/response types, ResponseMap, REPLY_TYPES
- `electron/terminal-host/index.ts` — handler + MAX_WRITE_FILE_BYTES
- `electron/terminal-host/control-queue.ts` — unserialized set
- `electron/terminal-host/rpc-channel.ts` — ConcurrentRequest
- `electron/terminal-host/client.ts` — `writeFile` method
- matching `*.test.ts` files
