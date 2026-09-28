---
title: CLI transport for the remote control port
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# CLI transport for the remote control port

See ADR-189 §3.

- `electron/mcp/http-client.ts`: when `process.env.MANOR_CONTROL_PORT_FILE` is set:
  - on every request, read the file (`<port>\n<token>\n`) and use only that port, on `127.0.0.1`, sending the token in the `x-manor-control-token` header. Define the header constant locally, with a comment saying it must match `CONTROL_TOKEN_HEADER` in `electron/terminal-host/control-relay-listener.ts`. Don't import it, because the CLI bundle must stay small and independent;
  - never fall back to `MANOR_WEBVIEW_PORT` or `~/.manor/webview-server-port`;
  - if the file is missing or unreadable, or the connection is refused, throw an error with the message "Manor's remote daemon isn't reachable. Reconnect the host in Manor";
  - non-2xx responses keep going through the existing `HttpError` path, so a 503 or 403 body's `error` reaches the user as it does today. Check how `cli.ts` prints `HttpError` and make sure `body.error` is shown.
- Without the env var, behaviour is unchanged.
- Tests in `http-client.test.ts` (create it if it doesn't exist, mocking `fetch` and fs): reads the port and token and sends the header; no fallback when the env var is set; the unreachable message; the existing path is unchanged.

## Files to touch
- `electron/mcp/http-client.ts` — remote port-file transport
- `electron/mcp/http-client.test.ts` — tests
