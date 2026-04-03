---
title: Migrate ProjectSetupWizard flex classes to Row/Stack
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate ProjectSetupWizard flex classes to Row/Stack

| CSS class | Component | Props |
|-----------|-----------|-------|
| `.container` | `Row` | `align="center" justify="center"` — keep className for height/width |
| `.header` | `Row` | `align="center" justify="space-between"` — keep className for padding |
| `.steps` | `Row` | `justify="center" gap="sm"` |
| `.stepContainer` | `Stack` | `gap="md"` |
| `.stepHeader` | `Stack` | (no props needed) |
| `.colorPicker` | `Row` | `gap="xxs"` |
| `.agentDiscovery` | `Row` | `align="center" gap="sm"` — keep className for padding |
| `.agentList` | `Stack` | `gap="xs"` — keep className for margin-bottom |
| `.commandRow` | `Row` | `align="center" gap="xxs"` |
| `.footer` | `Row` | `align="center" justify="space-between"` — keep className for padding |
| `.footerRight` | `Row` | `gap="sm"` — keep className for margin-left |

## Files to touch
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx` — swap divs for Row/Stack
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.module.css` — strip flex properties
