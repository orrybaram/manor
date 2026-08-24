---
title: End-to-end test against a real sshd, plus docs
status: todo
priority: medium
assignee: sonnet
blocked_by: [10, 11]
---

# End-to-end test against a real sshd, plus docs

Everything up to here is tested against fakes. Prove the bridge works against a real ssh
server, and write down how to use it.

**E2E.** Add a test that runs against `localhost` over real ssh, skipped unless an env
flag (`MANOR_E2E_SSH=1`) and a reachable target are present so CI and local runs do not
break for people without sshd. Prefer sshd-in-Docker if the repo already has container
tooling; otherwise document the `ssh localhost` setup requirement in the test's skip
message. Cover:

- Cold bootstrap: no `~/.manor/bin/manor-host` on the target → install → connect.
- Version mismatch: stale host binary → reinstall → connect.
- Create a session, write, read output back, resize, kill.
- Reverse hook forward: a curl to the forwarded port reaches `AgentHookServer` and moves
  a pane's agent status.
- Drop the ssh connection mid-session and assert reconnect with backoff, then a snapshot
  resync that does not duplicate output.

That last one matters: it is the same class of bug ADR-159 addressed for snapshot
sequencing, and a reconnect is exactly when it would resurface.

**Docs.** Write `docs/remote-hosts.md`: requirements (Node ≥ 20, ssh key auth,
`AllowTcpForwarding` for agent status), how to add a host, what runs where, what is not
yet supported (webview/MCP remoting, the directory picker, Windows hosts), and how to
diagnose each failure mode. Link it from `README.md`.

## Files to touch
- `tests/e2e/remote-host.spec.ts` — new.
- `scripts/test-remote-e2e.mjs` — new, if a harness/container setup is needed (follow
  `scripts/test-daemon-e2e.mjs`).
- `docs/remote-hosts.md` — new.
- `README.md` — link the doc.
