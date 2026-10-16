---
title: Typed template fields and the hosts.checkTemplate IPC (choices)
status: todo
priority: high
assignee: opus
blocked_by: [2]
---

# Typed template fields and the hosts.checkTemplate IPC (choices)

ADR-234 D6 (slice 2). The seam slice 3 builds the checklist on.

- `types.ts`: `FormField` gains `type?: "text" | "choice" | "size"`,
  `advanced?: boolean`, and for `size` a fixed `options` list. `TemplateInfo`
  carries them.
- New `TemplateCheck` / `Choice` / `TemplateCheckResult` types (shape in the
  ADR, D6 and D8) in `types.ts`, mirrored in `src/electron.d.ts`.
- New `electron/backend/providers/recipe-templates/checks/` with one module
  per template exporting `check(values, deps) → Promise<TemplateCheckResult>`.
  `deps` wraps `execFile` (with a per-call timeout, default 5 s) so tests can
  fake it. This ticket fills only `choices`:
  - kubernetes `context`: `kubectl config view -o json` → contexts, each with
    its cluster's server as `hint`; the current one's label suffixed
    "· kubectl's current".
  - docker `context`: `docker context ls --format '{{json .}}'`.
  - A missing CLI yields empty choices, not an error.
- Wire `hosts.checkTemplate(templateId, values)` through
  `electron/bridge/handlers/hosts.ts`, `routes.ts` (`"home"`),
  `local-only.ts`, `src/bridge/unavailable.ts`, the preload/`electron.d.ts`
  surface — follow exactly how `hosts.listTemplates` is wired.
- `StartHostForm.tsx`: render `choice` fields with `SearchableSelect`
  (options from `checkTemplate`, fetched on template pick and on window
  focus) and `size` fields with a segmented control (check `src/components/ui/`
  for one before building; use `Button`s otherwise). Text fields unchanged.
- Unit tests for both check modules with faked `execFile`.

## Files to touch
- `electron/backend/providers/recipe-templates/types.ts`, `index.ts`
- `electron/backend/providers/recipe-templates/checks/{index,docker,kubernetes}.ts` (new)
- `electron/bridge/handlers/hosts.ts`, `electron/bridge/routes.ts`, `electron/bridge/local-only.ts`
- `src/bridge/unavailable.ts`, `src/electron.d.ts`, preload if separate
- `src/components/settings/HostsPage/StartHostForm.tsx`
- tests under `electron/backend/__tests__/`
