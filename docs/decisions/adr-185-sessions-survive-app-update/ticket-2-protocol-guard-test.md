---
title: Guard test that protocol changes bump the protocol constants
status: todo
priority: high
assignee: sonnet
blocked_by: [1]
---

# Guard test that protocol changes bump the protocol constants

Read ADR-185 `index.md` §B.5. With app-version restarts gone, forgetting a
protocol bump means an old daemon silently serves an incompatible client.

Add `electron/terminal-host/protocol-guard.test.ts` plus a fixture
`electron/terminal-host/__fixtures__/protocol-guard.json`:

- Contract A (wire): the source text of `electron/terminal-host/types.ts`
  covering the protocol type declarations (ControlRequest, ControlResponse,
  stream command/event unions, and anything they reference in that file).
  Simplest robust option: hash the whole `types.ts` after stripping comments
  and whitespace, excluding the `TERMINAL_HOST_PROTOCOL` line itself. Choose
  something deterministic and explain it in a comment.
- Contract B (pty): `electron/terminal-host/pty-subprocess-ipc.ts`, normalized
  the same way, excluding the `PTY_SUBPROCESS_PROTOCOL` line.
- Fixture stores `{ wire: { protocol, hash }, pty: { protocol, hash } }`.
- Test: for each contract, if the current hash != fixture hash AND current
  constant == fixture protocol → fail with a message: "<file> changed but
  <CONST> was not bumped. If the change affects the daemon contract, bump
  <CONST>. Otherwise re-record with `UPDATE_PROTOCOL_GUARD=1 pnpm vitest run
  electron/terminal-host/protocol-guard`." If the constant was bumped, the test
  also fails until re-recorded (so the fixture tracks reality) — same message.
- `UPDATE_PROTOCOL_GUARD=1` rewrites the fixture and passes.
- Use node `crypto` sha256. Read files relative to the test file (`__dirname`
  or `import.meta.url` — match how other tests in this folder read files).

Record the initial fixture. Make sure knip (`knip.json`) doesn't flag the fixture.

## Files to touch
- `electron/terminal-host/protocol-guard.test.ts` — new
- `electron/terminal-host/__fixtures__/protocol-guard.json` — new
