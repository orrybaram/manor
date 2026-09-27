---
title: Docs, CONTEXT.md and end-to-end verification
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Docs, CONTEXT.md and end-to-end verification

1. Update `CONTEXT.md` if implementation sharpened any term: final module paths, the
   `PaneFacts` fields, the signal names.
2. Add a short "Superseded by ADR-184" note to the Consequences of ADR-139, ADR-012,
   ADR-014 and ADR-015, and a link from ADR-138's ticket 4.
3. E2E: write or adjust Playwright specs that assert the dot and its tooltip for a local
   agent turn (thinking → responded) and for agent exit (→ idle). **Do not run
   Playwright.** The orchestrator runs E2E.
4. Grep for leftover references to deleted names: `AgentDetector`, `relayAgentHook`,
   `agentStatus`, `"complete"` as a status, `notifyAgentDetectorGone`, `deriveStatus`.

## Files to touch
- `CONTEXT.md`, `docs/decisions/adr-139-*/index.md`, `adr-012-*`, `adr-014-*`, `adr-015-*`, `adr-138-*/ticket-4*`
- `tests/e2e/*` (agent status specs)
