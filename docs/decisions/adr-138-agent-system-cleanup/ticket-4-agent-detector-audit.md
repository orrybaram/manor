---
title: Audit AgentDetector for branches superseded by hook signal
status: done
priority: low
assignee: opus
blocked_by: []
---

# Audit AgentDetector for branches superseded by hook signal

`electron/terminal-host/agent-detector.ts` (395 lines) runs heuristic detection on session stdout to derive `AgentState.kind` and `.status`. Hook events are now authoritative for status; the detector remains load-bearing for unrecognized agents, kill -9 detection, and OSC 0/2 title extraction. The question is what's still needed and what's redundant.

See ADR-138 §"Change 4" for context.

## What to do

This ticket is an **audit, not a rewrite.** Read the file end-to-end. Categorize every code branch into one of:

- **Load-bearing** — the only path that produces this signal (e.g. OSC 0/2 title parsing, kill-9 process-gone detection).
- **Hook-supplemented** — produces the same signal as a hook event but is required for hook-less sessions (free shells, unrecognized agents).
- **Hook-redundant** — the hook event arrives reliably for this case AND the detector path runs in addition.
- **Dead** — branch never fires under current production state machines (all listed agent kinds have hooks).

Output: a markdown summary in this ticket's PR description (or as a follow-up doc, see below). Categorize with line ranges and a one-sentence justification each.

If the audit surfaces clearly dead branches (last category), delete them in the same PR — but **only the ones with no plausible activation path**. Anything ambiguous stays. The audit is more valuable than the deletion.

## Decision aid

Helpful comparisons:
- `mapEventToStatus` in `electron/agent-hooks.ts:23-46` lists the 11 hook events the relay handles. Any detector branch that produces a status already covered by an inbound hook event for the same agent kind is a candidate for "hook-redundant".
- `notifyAgentDetectorGone` in `hook-relay.ts:361-381` shows the bridge: when the detector emits `kind: null && status: idle`, the relay treats that as "process gone" and force-stops. This is the load-bearing kill-9 path.

## Output

Either:
- A new file `docs/architecture/agent-detector-audit.md` with the categorization (preferred — survives the PR).
- The PR description, if the audit is short.

If the audit recommends a follow-up rewrite, file a new ADR rather than expanding this ticket.

## Files to touch

Reading: `electron/terminal-host/agent-detector.ts`, `electron/agent-hooks.ts`, `electron/hook-relay.ts`.

Writing: new doc file (per above), and possibly small deletions in `agent-detector.ts` if any branches are unambiguously dead.

## Notes

Opus-assigned because the categorization needs careful reasoning about state-machine interactions. There is no test plan because the deliverable is a document, not behaviour change. If deletions happen as part of this ticket, they get the existing detector test coverage (whatever that is) plus a new test exercising the hookless-session path.
