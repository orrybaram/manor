---
title: Lazy-load modals and dialogs in App.tsx
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# Lazy-load modals and dialogs in App.tsx

Convert eagerly imported modal/dialog components to `React.lazy()` with `Suspense` boundaries.

## Changes

In `src/App.tsx`:

1. Replace these static imports with `React.lazy`:
   ```tsx
   // Remove these:
   import { SettingsModal } from "./components/SettingsModal";
   import { NewWorkspaceDialog } from "./components/NewWorkspaceDialog";
   import { ProjectSetupWizard } from "./components/ProjectSetupWizard";
   import { TasksModal } from "./components/TasksView";
   import { CommandPalette } from "./components/CommandPalette";

   // Add these:
   import { lazy, Suspense } from "react";  // add lazy and Suspense to existing import
   const SettingsModal = lazy(() => import("./components/SettingsModal").then(m => ({ default: m.SettingsModal })));
   const NewWorkspaceDialog = lazy(() => import("./components/NewWorkspaceDialog").then(m => ({ default: m.NewWorkspaceDialog })));
   const ProjectSetupWizard = lazy(() => import("./components/ProjectSetupWizard").then(m => ({ default: m.ProjectSetupWizard })));
   const TasksModal = lazy(() => import("./components/TasksView").then(m => ({ default: m.TasksModal })));
   const CommandPalette = lazy(() => import("./components/CommandPalette").then(m => ({ default: m.CommandPalette })));
   ```

2. Wrap each lazy component in `<Suspense fallback={null}>` in the JSX. Use `null` fallback since these are modals that animate in — no visible flash.

3. Keep `CloseAgentPaneDialog` as a static import — it's tiny and used for confirmation prompts that need instant display.

4. Keep the `PaletteView` type import as a static `import type` (types are erased at build time).

## Files to touch
- `src/App.tsx` — convert imports, add Suspense wrappers
