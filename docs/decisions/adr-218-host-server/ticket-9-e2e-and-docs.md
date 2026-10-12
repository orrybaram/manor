---
title: End-to-end test with the laptop gone, and docs
status: todo
priority: high
assignee: sonnet
blocked_by: [5, 6, 7, 8, 10]
---

# End-to-end test with the laptop gone, and docs

## E2E
Extend the Docker sshd harness (`scripts/test-remote-e2e.mjs --docker`, `tests/e2e/remote-host/Dockerfile`):

1. The desktop sets up a project on the container host and launches the fake agent.
2. Pair a device with the host server. Use a local relay (`wrangler dev` or the relay test harness the relay e2e already uses).
3. **Kill the desktop's SSH connection**, or quit the app.
4. A Playwright page opens the pairing link. Assert:
   - the agent is listed with status;
   - a hook event emitted after the disconnect changes that status;
   - typing into the terminal reaches the PTY.
5. Reconnect the desktop. Assert the desktop's agent state matches the host server's (two readers, one journal).

Note the WSL setup in memory `e2e-on-this-wsl-box` (DISPLAY, Node 22).

## Docs
- `docs/remote-hosts.md`: the host server, what the phone can do with the lid closed, where secrets live (plaintext 0600) and why.
- `docs/remote-control.md`: pairing a phone with a host.
- `CONTEXT.md`: add **Host server** (a headless Manor server on a remote host) and the **owner channel**. Update the Host entry, and the "remote" ambiguity note.

## Files to touch
- `scripts/test-remote-e2e.mjs`, `tests/e2e/remote-host/*`, a new spec under `tests/e2e/`
- `docs/remote-hosts.md`, `docs/remote-control.md`, `CONTEXT.md`
