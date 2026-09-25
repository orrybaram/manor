---
title: Remote projects docs and laptop-closed E2E
status: todo
priority: medium
assignee: sonnet
blocked_by: [3, 5, 6, 7]
---

# Remote projects docs and laptop-closed E2E

1. **Docs:** `docs/remote-projects.md` — choosing a box (Hetzner CX33, exe.dev, a Mac
   mini, Coder), requirements (Node ≥ 20, git, ssh key access), first-run login on the
   box (`gh auth login`, `claude setup-token`, `codex login`), the credential stance
   (nothing copied, no agent forwarding), where the hook journal lives and its cap,
   and what happens when the box reboots.
2. **E2E:** extend ADR-160 ticket 12's sshd-container harness with a "laptop closed"
   scenario: start an agent stub in a remote pane that fires hook events on a timer;
   kill the ssh transport; let it fire `Stop`; restore; assert the sidebar shows the
   final status and exactly one notification. Second scenario: restart the remote
   daemon and assert the pane is resumed with the stub's resume command.
   Run E2E in the background and read Playwright's own summary.

## Files to touch
- `docs/remote-projects.md` — new.
- `e2e/` — laptop-closed and remote-restart scenarios (next to ADR-160's sshd harness).
