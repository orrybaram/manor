# Manor

A desktop workspace manager for running coding agents (Claude, Codex, pi, opencode)
in terminal panes across local and remote hosts.

## Language

### Agents

**Agent**:
One coding-agent session running in a terminal pane, persisted in `agents.json`.
_Avoid_: task (older name, still in some code), session (that is the hook-level id)

**Agent kind**:
Which agent CLI an **Agent** is: `claude`, `codex`, `pi` or `opencode`.
_Avoid_: harness, agent type

**Agent status**:
The one live state shown for an **Agent**'s pane (thinking, working, requires input,
responded, error, idle), decided only by the **Status reconciler**. A finished turn is
**responded**; an ended session is **idle** (its **Agent** lifecycle becomes `completed`).
_Avoid_: dot state, detector status, live status, "complete" (removed — use responded, or the lifecycle)

**Status signal**:
A single piece of evidence about an **Agent**'s state: a hook event, a daemon
report of the foreground process, terminal title or output pattern, or a **tick**
(the current time, which is how every time-based rule — stuck-working, orphan and
held-Stop recovery — reaches the **Status reconciler**).
_Avoid_: fallback status, hint

**Pane facts**:
The daemon's latest snapshot of what it can see in a pane: foreground process (and its
**Agent kind**, if known), last terminal title, and last output hint with its time. Sent on
change and on request; a source of **Status signals**, never an **Agent status**.
_Avoid_: detector state, agent state

**Hook-driven**:
An **Agent** whose root session has sent at least one hook signal; from then until the session
ends, only hook signals decide its turn statuses.
_Avoid_: "has hooks", "hook-capable" (support is observed, not declared)

**Status reconciler**:
The one module, in Electron main, that turns **Status signals** for a pane into its
**Agent status** and the reason for it.
_Avoid_: detector, relay (those become signal sources/effects, not deciders)

## Relationships

- A pane has at most one root **Agent** at a time; child sessions (subagents) belong to it.
- A child session's activity may show as the pane's **Agent status** while the root's turn is in
  progress, but only the root's own signals can end a turn (**responded**, **error**, **idle**).
- The **Status reconciler** consumes many **Status signals** and emits one **Agent status** per pane.
- The daemon produces **Status signals**; it does not decide **Agent status**.
- Hook signals decide an **Agent**'s turn statuses. Daemon signals (foreground process, title,
  output patterns) decide only liveness (process gone → **idle**) — unless the **Agent** has no
  hook signals, in which case they decide everything.
- The **Status reconciler** is the only writer of an **Agent**'s lifecycle and last **Agent status**;
  the renderer displays what it publishes and does not re-derive it.

## Example dialogue

> **Dev:** "The title says `✳ Done` but the dot still shows working — who's right?"
> **Domain expert:** "Neither on its own. The title is a **Status signal**; the **Status reconciler**
> weighs it against the last hook and decides the **Agent status**."

## Flagged ambiguities

- "status" was used for both the persisted lifecycle (`active`/`completed`/`abandoned`/`error`)
  and the live **Agent status** — resolved: the persisted one is the **Agent**'s lifecycle,
  the live one is **Agent status**.
