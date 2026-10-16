---
title: The Connect step's checklist, Advanced disclosure and plain copy
status: in-progress
priority: high
assignee: opus
blocked_by: [6]
---

# The Connect step's checklist, Advanced disclosure and plain copy

ADR-234 D7 (slice 3). Mockups: the two proposal pages linked from the ADR.

- `StartHostForm.tsx` for a template: visible fields (non-`advanced`), then
  a `TemplateChecklist` component (new, in `HostsPage/`): one row per check
  with an icon per state (reuse `HostStateIcon` tones if they fit), title,
  detail, and its fix as a `Button` (or a progress bar for `busy` with
  progress). Then an "Advanced" disclosure (check `ui/` for Collapse /
  disclosure) with the advanced fields. Start disabled until every check is
  `ok` and required fields are filled.
- Refresh: on template pick, window focus, field change (300 ms debounce),
  every 2 s while any check is `busy`; ignore stale responses.
- Mark advanced fields in the templates: Docker — name, image, context;
  Kubernetes — name, namespace, image, storage, storageClass. Rename
  templates/descriptions in plain words ("Docker container on this
  computer", "Kubernetes cluster"), and add field descriptions that explain
  each term in one sentence (ADR's Kubernetes "plain words" paragraph).
- Keep existing test ids; add `start-host-check-<id>` and
  `start-host-fix-<id>`. Update e2e specs/helpers that fill the old flat
  form (grep `start-host-field-`). Component test for the checklist states.

## Files to touch
- `src/components/settings/HostsPage/StartHostForm.tsx`
- `src/components/settings/HostsPage/TemplateChecklist.tsx` (+ module.css) (new)
- `electron/backend/providers/recipe-templates/{docker,kubernetes}.ts` — `advanced`, copy
- e2e specs/helpers touching the start-host form
