---
title: TypeSafe (Jev) key section in Integrations settings
status: todo
priority: medium
assignee: haiku
blocked_by: [1]
---

# TypeSafe (Jev) key section in Integrations settings

Create `src/components/settings/TypeSafeIntegrationSection.tsx`, closely modeled on `src/components/settings/LinearIntegrationSection.tsx`. Use the same components (`Button`, `Input` type password, `Stack`/`Row`, `SectionTitle`, `useMountEffect`, `useToastStore`), the same connect/disconnect flow, and the same error toasts. The only differences:

- Calls `window.electronAPI.typesafe.isConnected()`, `.connect(key.trim())` and `.disconnect()`. `connect` resolves to `void`; there is no viewer name to show, so the connected state just reads "Connected".
- Title is "TypeSafe (Jev)".
- The helper text says what it does and what it sends: "Suggests a sidebar folder for new workspaces. The workspace name, branch, agent prompt and your folder and workspace names are sent to TypeSafe."
- Link to get a key: `https://typesafe.ai`, using `<Link>` from `src/components/ui/Link/Link`, per `.claude/rules/ui-components.md`. Mirror whatever the Linear section does for its key link.

Mount it in `src/components/settings/IntegrationsPage.tsx` after `LinearIntegrationSection`.

Run `pnpm typecheck`.

## Files to touch
- `src/components/settings/TypeSafeIntegrationSection.tsx`: new
- `src/components/settings/IntegrationsPage.tsx`: mount it
