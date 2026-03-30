---
title: Remove modal-like borders from wizard
status: done
priority: high
assignee: haiku
blocked_by: []
---

# Remove modal-like borders from wizard

The wizard currently has a card-like appearance with borders. Remove them so it looks inline.

## Implementation

In `src/components/ProjectSetupWizard.module.css`:
- `.card`: Remove `border: 1px solid var(--surface)`
- `.header`: Remove `border-bottom: 1px solid var(--surface)`
- `.footer`: Remove `border-top: 1px solid var(--surface)`

## Files to touch
- `src/components/ProjectSetupWizard.module.css` — remove border properties from `.card`, `.header`, `.footer`
