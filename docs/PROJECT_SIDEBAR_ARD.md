# Plan: Project Sidebar with Worktree Support

## Context

Manor is currently a tab-based terminal app where tabs and panes are managed directly by `ManorWindowController`. We want to introduce **Projects** as the top-level entity — each project is a git repo, owns its own tabs, and exposes its git worktrees. A sidebar provides navigation between projects and their worktrees.

**Target layout:**
```
┌──────────┬──────────────────────────────┐
│ Sidebar  │ TabBarView (28px)            │
│          ├──────────────────────────────┤
│ Projects │ PaneContainerView            │
│  > Wt1   │  (terminal splits)          │
│  > Wt2   │                             │
│          │                             │
│  [+ Add] │                             │
└──────────┴──────────────────────────────┘
```

---

## Phase 1: Models

### 1a. Create `Sources/ManorApp/Models/ProjectModel.swift`

```swift
struct ProjectModel {
    let id: UUID
    var name: String           // repo folder name
    var path: URL              // git repo root
    var tabs: [TabModel]
    var selectedTabIndex: Int
    var worktrees: [WorktreeInfo]
}

struct WorktreeInfo: Hashable {
    let path: String
    let branch: String
    let isMain: Bool
}
```

Add a `GitHelper` enum with static methods:
- `isGitRepo(at: URL) -> Bool` — runs `git rev-parse --is-inside-work-tree`
- `listWorktrees(at: URL) -> [WorktreeInfo]` — parses `git worktree list --porcelain`
- `repoName(at: URL) -> String` — returns last path component

Use `Process` for shell commands (synchronous, these are fast).

### 1b. Create `Sources/ManorApp/Models/ProjectPersistence.swift`

```swift
struct PersistedProject: Codable {
    let id: UUID
    let name: String
    let path: String
}

struct PersistedState: Codable {
    var projects: [PersistedProject]
    var selectedProjectIndex: Int
}
```

- Save/load JSON to `~/Library/Application Support/Manor/projects.json`
- Only persists project paths (not tabs/panes — those are ephemeral terminal state)

---

## Phase 2: Sidebar View

### 2a. Create `Sources/ManorApp/Views/ProjectSidebarView.swift`

Custom `NSView` with direct `draw(_:)` rendering (consistent with `TabBarView` pattern):

- Renders project list with disclosure triangles for worktrees
- Each project row: name, expand/collapse arrow, remove button on hover
- Expanded projects show worktrees indented (branch name + path)
- "+" button at bottom to add projects
- Selected project highlighted

**Delegate protocol:**
```swift
protocol ProjectSidebarDelegate: AnyObject {
    func sidebar(_ sidebar: ProjectSidebarView, didSelectProject index: Int)
    func sidebar(_ sidebar: ProjectSidebarView, didSelectWorktree: WorktreeInfo, inProject: Int)
    func sidebarDidRequestAddProject(_ sidebar: ProjectSidebarView)
    func sidebar(_ sidebar: ProjectSidebarView, didRequestRemoveProject index: Int)
}
```

**Properties:**
- `projects: [(id: UUID, name: String, worktrees: [WorktreeInfo])]`
- `selectedProjectIndex: Int`
- `expandedProjectIDs: Set<UUID>`

### 2b. Sidebar divider (drag-to-resize)

Handle as part of `ProjectSidebarView` — a thin hit-test region on the right edge that allows dragging to resize the sidebar width. Min 120px, max 300px, default 180px. Store width in `UserDefaults`.

---

## Phase 3: Window Controller Refactor

**File:** `Sources/ManorApp/App/ManorWindowController.swift`

### 3a. State changes

Replace:
```swift
private var tabs: [TabModel] = []
private var selectedTabIndex: Int = 0
```
With:
```swift
private var projects: [ProjectModel] = []
private var selectedProjectIndex: Int = 0
```

Add convenience accessors to minimize diff:
```swift
private var currentProject: ProjectModel? { ... }
private var currentTabs: [TabModel] { currentProject?.tabs ?? [] }
private var currentSelectedTabIndex: Int { currentProject?.selectedTabIndex ?? 0 }
```

Update all existing methods that reference `tabs[selectedTabIndex]` to use `projects[selectedProjectIndex].tabs[projects[selectedProjectIndex].selectedTabIndex]`.

### 3b. Layout changes in `setupViews()`

Add sidebar to the left:
```
sidebar | divider | tabBar + paneContainer
```

- `sidebarView` pinned to left, top, bottom with a width constraint
- `tabBarView.leadingAnchor` → `sidebarView.trailingAnchor` (was `contentView.leadingAnchor`)
- `paneContainer.leadingAnchor` → `sidebarView.trailingAnchor`
- Store sidebar width constraint as a property for resize

### 3c. Project management methods

- `addProject()` — show `NSOpenPanel` (directory mode), validate git repo via `GitHelper`, create `ProjectModel`, refresh sidebar, select new project
- `removeProject(at:)` — destroy all surfaces for that project's panes, remove from array
- `selectProject(at:)` — update `selectedProjectIndex`, call `refreshLayout()` which shows the correct project's tabs/panes
- `openWorktreeTerminal(_ worktree:)` — create a new tab, set working directory on the ghostty surface config or send `cd <path> && clear\n` after creation
- `refreshWorktrees()` — re-run `git worktree list` for current project, update model + sidebar

### 3d. Surface lifecycle across projects

`paneSurfaces` remains a flat `[PaneID: GhosttySurfaceView]` dict. Surfaces from inactive projects stay alive but hidden (removed from superview). `PaneContainerView.layout()` already handles this — it hides views not in the active tree.

### 3e. Close behavior change

- Closing last pane in last tab of a project → remove project from sidebar
- Closing last project → close window (same as current last-tab behavior)

### 3f. Keybindings

Add to `KeyAction` and `appKeyAction`:
- `Cmd+\` (keyCode 42) → toggle sidebar visibility
- `Cmd+Shift+O` (keyCode 31) → add project

### 3g. GhosttyAppDelegate updates

- `SET_TITLE`: search across all projects' tabs (not just current) since background surfaces can send title updates
- `SHOW_CHILD_EXITED` / `closeSurface`: `removePaneFromCurrentTab` already finds the correct tab via `firstIndex(where:)` — needs to search across all projects

### 3h. Conform to `ProjectSidebarDelegate`

Wire up sidebar delegate methods to the project management methods.

---

## Phase 4: Menu & Persistence

### 4a. `Sources/ManorApp/App/AppDelegate.swift`

Add a "Project" menu:
- "Open Project..." (`Cmd+Shift+O`)
- "Toggle Sidebar" (`Cmd+\`)

### 4b. Persistence hooks

- `applicationDidFinishLaunching`: load persisted projects, create `ProjectModel` for each valid path
- `applicationWillTerminate` / window close: save current project list

---

## Phase 5: Initial State & Edge Cases

- If no persisted projects on launch → start with an empty project (unnamed, single tab) matching current behavior
- If a persisted project path no longer exists → skip it silently on load
- `refreshWorktrees()` called when selecting a project (worktree list can change)

---

## Files to Create
1. `Sources/ManorApp/Models/ProjectModel.swift` — ProjectModel, WorktreeInfo, GitHelper
2. `Sources/ManorApp/Models/ProjectPersistence.swift` — PersistedState, save/load
3. `Sources/ManorApp/Views/ProjectSidebarView.swift` — Sidebar view + delegate protocol

## Files to Modify
4. `Sources/ManorApp/App/ManorWindowController.swift` — Major: projects replace tabs, sidebar integration
5. `Sources/ManorApp/App/AppDelegate.swift` — Minor: new menu items, persistence hooks

## Files Unchanged
- `PaneModel.swift` — TabModel/PaneNode work as-is inside ProjectModel
- `PaneContainerView.swift` — Already handles show/hide correctly
- `TabBarView.swift` — Already data-driven via `update(tabs:selectedIndex:)`
- `GhosttySurfaceView.swift` — No changes needed
- `GhosttyApp.swift` / `GhosttyCallbacks.swift` — No changes needed

---

## Verification

1. Build and launch — app should start with empty sidebar + one default project
2. Click "+" or `Cmd+Shift+O` → file picker → select a git repo → appears in sidebar
3. Select a project → its tabs/panes appear in the content area
4. Expand a project in sidebar → see worktrees listed
5. Click a worktree → new tab opens with terminal cd'd to that worktree path
6. Switch between projects → each has independent tabs/panes, terminals stay alive
7. Remove a project → its surfaces are destroyed, sidebar updates
8. Quit and relaunch → projects are restored in sidebar (terminals are fresh)
9. `Cmd+\` → sidebar toggles visibility
10. All existing keybindings (splits, tabs, focus) work within the selected project
