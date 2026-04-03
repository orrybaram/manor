---
title: Replace lucide-react barrel imports with direct path imports
status: done
priority: critical
assignee: haiku
blocked_by: []
---

# Replace lucide-react barrel imports with direct path imports

Replace all barrel imports from `lucide-react` with direct ESM path imports to avoid bundling the entire icon library.

## Pattern

**Before:**
```tsx
import { Check, X, Menu } from "lucide-react";
```

**After:**
```tsx
import { Check } from "lucide-react/dist/esm/icons/check";
import { X } from "lucide-react/dist/esm/icons/x";
import { Menu } from "lucide-react/dist/esm/icons/menu";
```

Note: lucide-react uses named exports from each icon file, so use `{ IconName }` not default imports.

The icon file name is the kebab-case version of the PascalCase import name:
- `Check` → `check`
- `ArrowLeft` → `arrow-left`
- `RotateCw` → `rotate-cw`
- `ChevronRight` → `chevron-right`
- `FolderGit2` → `folder-git-2`
- `GitBranch` → `git-branch`
- `GitMerge` → `git-merge`
- `ListChecks` → `list-checks`
- `ListTodo` → `list-todo`
- `EthernetPort` → `ethernet-port`
- `ExternalLink` → `external-link`
- `FolderOpen` → `folder-open`
- `RotateCcw` → `rotate-ccw`
- `RefreshCw` → `refresh-cw`
- `ChevronDown` → `chevron-down`
- `ZoomIn` → `zoom-in`
- `ZoomOut` → `zoom-out`
- `Github` → `github`
- `Download` → `download`
- `Loader2` → `loader-2`

## Files to touch

All files importing from `"lucide-react"` in `src/`:

- `src/components/LeafPane.tsx` — ArrowLeft, ArrowRight, RotateCw, Crosshair, ZoomIn, ZoomOut
- `src/components/ProjectSettingsPage.tsx` — Check, Trash2, Plus
- `src/components/GitHubIntegrationSection.tsx` — Link, RefreshCw
- `src/components/DeleteWorktreeDialog.tsx` — GitBranch
- `src/components/ThemeSection.tsx` — Check
- `src/components/NewWorkspaceDialog.tsx` — X, ChevronDown, Loader2
- `src/components/TabBar.tsx` — Plus, Globe, ListTodo
- `src/components/ProjectSetupWizard.tsx` — Check, Loader2, Trash2, Plus
- `src/components/WorkspaceEmptyState.tsx` — Terminal, Search, Trash2, ExternalLink, Plus, Globe
- `src/components/CommandPalette/IssueDetailView.tsx` — ArrowLeft
- `src/components/PortsList.tsx` — ChevronRight, EthernetPort
- `src/components/ProjectItem.tsx` — Plus, ChevronRight, House, FolderGit2
- `src/components/TasksList.tsx` — ListChecks, X
- `src/components/CommandPalette/useWorkspaceCommands.tsx` — House, FolderGit2, Plus
- `src/components/CommandPalette/useCustomCommands.tsx` — Terminal
- `src/components/GitHubNudge.tsx` — Github, X, Download, Check, RotateCcw
- `src/components/LinearIntegrationSection.tsx` — Link, Unlink
- `src/components/KeybindingsPage.tsx` — RotateCcw, Check, X
- `src/components/TasksView.tsx` — X, Trash2
- `src/components/MergeWorktreeDialog.tsx` — GitBranch, GitMerge, Trash2
- `src/components/CommandPalette/IssueDetailSkeleton.tsx` — ArrowLeft
- `src/components/SessionButton.tsx` — Globe, X
- `src/components/Sidebar.tsx` — Plus, Boxes, ChevronRight
- `src/components/CommandPalette/CommandPalette.tsx` — ChevronRight, ArrowLeft
- `src/components/CommandPalette/GitHubIssueDetailView.tsx` — ArrowLeft
- `src/components/LinearProjectSection.tsx` — Check, ChevronDown
- `src/components/CommandPalette/useTaskCommands.tsx` — ListTodo, Plus
- `src/components/CommandPalette/useCommands.tsx` — Globe
- `src/components/LinkedIssuesPopover.tsx` — Unlink
- `src/components/PortBadge.tsx` — ExternalLink
- `src/components/WelcomeEmptyState.tsx` — FolderOpen
- `src/components/SettingsModal.tsx` — X, ChevronDown, ChevronRight, Palette, Keyboard, Bell, Link
- `src/components/PrPopover.tsx` — check for lucide imports here too

## Verification
After changes, run `bun run typecheck` and `bun run build` to confirm no import errors.
