---
title: "ADR-015: Debounce agent status transitions"
status: accepted
date: 2026-03-21
---

# ADR-015: Debounce agent status transitions

## Context

Agent status can rapidly alternate between "thinking" and "working", causing the UI indicator (dot/spinner) to flicker. Both states represent "active agent" — the visual difference (pulsing blue dot vs spinning yellow loader) switching rapidly is distracting.

## Decision

Add a `useDebouncedAgentStatus` hook that delays transitions between thinking↔working by 500ms. If the status changes back within that window, the visual stays on the previous state. Transitions to other states (idle, complete, requires_input, error) apply immediately since they represent meaningful state changes the user should see right away.

Apply this hook inside `AgentDot` so all consumers benefit.

## Consequences

- Smoother visual experience when agents rapidly switch between thinking/working
- Tiny delay (up to 500ms) before the dot style updates between these two states — acceptable since both indicate "agent is active"
