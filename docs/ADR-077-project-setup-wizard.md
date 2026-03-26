# ADR-077: First-Run UX — Project Setup Wizard

## Status

Proposed

## Context

When Manor has zero projects, the empty state (`WelcomeEmptyState`) shows an "Import Project" button. Clicking it opens a native directory picker, derives the project name from the folder, and immediately creates the project with all defaults. There is no guided setup — users must discover settings like agent command, worktree path, and integrations by navigating to Project Settings after the fact.

This creates two problems:

1. **First-run friction** — new users don't know what Manor can do or how to configure it. The most impactful settings (agent command, worktree path) are buried in a settings page they may never visit.
2. **Repeat friction** — even experienced users adding a second project must remember to open settings and configure the same fields every time.

The existing `ProjectSettingsPage` already has all the form fields. What's missing is a guided entry point that surfaces the most important ones at project-creation time, with every step skippable so power users aren't slowed down.

GitHub issue: [#48](https://github.com/orrybaram/manor/issues/48)

## Decision

### Add a multi-step wizard modal that opens after folder selection

The native directory picker stays as-is. After the user selects a folder, instead of immediately creating the project, open a wizard modal that walks through configuration in discrete steps. Every step has a "Skip" action — skipping uses sensible defaults and advances to the next step.

### Wizard steps

#### Step 0: Folder Selection (pre-modal)

Same as today — native `dialog:openDirectory`. On selection, open the wizard modal with the selected path.

#### Step 1: Name & Color

- **Project name** — text input, pre-filled from the folder name, editable.
- **Color picker** — same 6 presets as `ProjectSettingsPage` (red, green, yellow, blue, magenta, cyan) plus "Default". Auto-select a random color so every project has visual identity from the start.
- Skip uses folder name + random color.

#### Step 2: Agent Command

- **Agent command** — text input with the current default placeholder (`claude` or whatever `DEFAULT_AGENT_COMMAND` resolves to).
- Brief helper text explaining this is the command Manor runs in new terminal panes.
- Skip uses the global default.

#### Step 3: Worktree Configuration

- **Worktree path** — text input, pre-filled with `~/.manor/worktrees/{slugified-project-name}`. Explain that Manor creates git worktrees here for branch-based workspaces.
- Skip uses the pre-filled default.

#### Step 4: Linear Integration (conditional)

- If Linear is **already connected** globally: show a team picker (checkboxes, same as `LinearProjectSection`) so the user can associate teams with this project.
- If Linear is **not connected**: show a brief prompt with an API key input and "Connect" button (same flow as `LinearIntegrationSection`), plus a "Skip" to ignore entirely.
- Skip leaves no Linear associations.

#### Final: Done

Create the project with all collected settings in a single `addProject` + `updateProject` call sequence. Select the new project and switch to its main workspace.

### Entry points

| Trigger | Behavior |
|---|---|
| `WelcomeEmptyState` "Import Project" button | Opens directory picker, then wizard |
| Sidebar "+" / "Add Project" action | Opens directory picker, then wizard |
| Command palette "Add Project" | Opens directory picker, then wizard |

All paths that currently call `addProjectFromDirectory()` should instead go through the wizard flow.

### Component architecture

```
ProjectSetupWizard (Radix Dialog)
├── WizardStepIndicator (dots / step labels showing progress)
└── Step content (conditional render by step index)
    ├── NameColorStep
    ├── AgentCommandStep
    ├── WorktreeStep
    └── LinearStep
```

- **Single new component**: `ProjectSetupWizard.tsx` with a corresponding CSS module.
- Reuse the existing color picker markup from `ProjectSettingsPage` (extract to a shared `ColorPicker` component or inline — keep it simple).
- Reuse `LinearProjectSection` team-picker logic for Step 4.
- The wizard holds all state locally until the final "Done" step, then persists everything at once. No partial project creation.

### State flow

```
User clicks "Import Project"
  → electronAPI.dialog.openDirectory()
  → If path selected, open wizard modal with { path, defaultName }
  → User navigates steps (Next / Skip / Back)
  → On final step "Done":
      1. addProject(name, path)        → creates project with defaults
      2. updateProject(id, { color, agentCommand, worktreePath, linearAssociations })
      → select new project
      → close wizard
```

The wizard does **not** touch `createWorktree` — it only configures the project. Workspace/worktree creation remains a separate action via `NewWorkspaceDialog`.

### UI details

- **Dialog size**: ~480px wide (between the 400px `NewWorkspaceDialog` and 760px `SettingsModal`).
- **Step indicator**: Horizontal dots at the top of the modal, one per step. Current step is accented, completed steps are filled, future steps are dimmed.
- **Navigation**: "Back" (left) and "Next" / "Skip" (right) buttons in the footer. Step 1 has no Back. Final step shows "Done" instead of Next.
- **Animations**: Match existing dialog patterns — `scaleIn` / `scaleOut` for the modal, crossfade between steps.
- **Keyboard**: Enter advances, Escape closes (with confirmation if any field was edited).

### What this does NOT include

- **Theme selection** — low priority for first-run, available in Project Settings.
- **Custom commands** — too advanced for onboarding.
- **Start/teardown scripts** — power-user feature, discoverable in settings.
- **Default run command** — same reasoning.

These are all accessible in Project Settings after creation.

## Consequences

### Positive

- New users get a guided introduction to Manor's key features without reading docs.
- Every project starts with a color and sensible worktree path instead of blank defaults.
- Linear integration is discoverable at the moment it's most useful (project creation).
- All steps are skippable, so experienced users can blitz through with Enter/Enter/Enter/Done.

### Negative

- Adds a new component (~200-300 lines) and CSS module.
- Slightly longer path to "project created" for users who just want to pick a folder and go — mitigated by making every step skippable with keyboard shortcuts.
- The wizard duplicates some form fields from `ProjectSettingsPage` — if we extract shared components (color picker, etc.) this stays manageable, but we should be intentional about not letting the two drift apart.

### Risks

- Over-engineering the wizard with too many steps will hurt the "fast path" UX. Four steps is the max — if we're tempted to add more, push them to Project Settings instead.
- The conditional Linear step (connected vs not) adds branching complexity. If it proves too heavy, we can simplify to only showing the team picker when already connected and skipping the step entirely otherwise.
