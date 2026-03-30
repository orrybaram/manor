---
title: Split small multi-component files
status: todo
priority: high
assignee: sonnet
blocked_by: []
---

# Split small multi-component files

Split the remaining multi-component files so each component has its own file.

## SessionButton.tsx (180 lines)

### `src/components/useSessionTitle.ts`
- Move `useSessionTitle` hook

### `src/components/useSessionAgentStatus.ts`
- Move `useSessionAgentStatus` hook and `STATUS_PRIORITY` constant

### `src/components/TabAgentDot.tsx`
- Move `TabAgentDot` component
- Import `useSessionAgentStatus` from `./useSessionAgentStatus`

### `src/components/SessionButton.tsx`
- Keep `SessionButton` and `shortenTitle` (only used here)
- Import `useSessionTitle` from `./useSessionTitle`
- Import `TabAgentDot` from `./TabAgentDot`

## ProjectSettingsPage.tsx (259 lines)

### `src/components/LinearProjectSection.tsx`
- Move `LinearProjectSection` component with all its state and imports

### `src/components/ProjectSettingsPage.tsx`
- Remove `LinearProjectSection`, import from `./LinearProjectSection`

## IntegrationsPage.tsx (129 lines)

### `src/components/LinearIntegrationSection.tsx`
- Move `LinearIntegrationSection` component

### `src/components/IntegrationsPage.tsx`
- Remove `LinearIntegrationSection`, import from `./LinearIntegrationSection`

## PortsList.tsx (108 lines)

### `src/components/PortGroup.tsx`
- Move `PortGroup` component

### `src/components/PortBadge.tsx`
- Move `PortBadge` component

### `src/components/PortsList.tsx`
- Remove `PortGroup` and `PortBadge`, import from new files

## Toast.tsx (59 lines)

### `src/components/ToastItem.tsx`
- Move `ToastItem` component and `AUTO_DISMISS_MS` constant

### `src/components/Toast.tsx`
- Remove `ToastItem`, import from `./ToastItem`

## Files to touch
- `src/components/SessionButton.tsx` — extract hooks and TabAgentDot
- `src/components/useSessionTitle.ts` — create
- `src/components/useSessionAgentStatus.ts` — create
- `src/components/TabAgentDot.tsx` — create
- `src/components/ProjectSettingsPage.tsx` — extract LinearProjectSection
- `src/components/LinearProjectSection.tsx` — create
- `src/components/IntegrationsPage.tsx` — extract LinearIntegrationSection
- `src/components/LinearIntegrationSection.tsx` — create
- `src/components/PortsList.tsx` — extract PortGroup, PortBadge
- `src/components/PortGroup.tsx` — create
- `src/components/PortBadge.tsx` — create
- `src/components/Toast.tsx` — extract ToastItem
- `src/components/ToastItem.tsx` — create
