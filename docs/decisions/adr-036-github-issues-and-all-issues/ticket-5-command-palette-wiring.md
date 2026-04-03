---
title: Wire up command palette with all issue views
status: todo
priority: high
assignee: opus
blocked_by: [4]
---

# Wire up command palette with all issue views

Update `CommandPalette.tsx` and `LinearIssuesView.tsx` to support both providers and both "My Issues" / "All Issues" modes.

## PaletteView type (`types.ts`)

Update `PaletteView`:
```typescript
export type PaletteView =
  | "root"
  | "linear"
  | "linear-all"
  | "github"
  | "github-all"
  | "issue-detail"
  | "github-issue-detail";
```

## LinearIssuesView.tsx changes

Add `allIssues?: boolean` prop. When `allIssues` is true:
- Change query key to `["linear-all-issues", allTeamIds]`
- Call `window.electronAPI.linear.getAllIssues(allTeamIds, { stateTypes: ["unstarted", "backlog"], limit: 50 })`
- Change group heading to `"All Issues"`

When `allIssues` is false (or omitted), behavior stays exactly the same as current.

## CommandPalette.tsx changes

### State
- Add `githubConnected` state (boolean), checked on open via `window.electronAPI.github.checkStatus()`
- Add `selectedGitHubIssueNumber` state (number | null)
- Derive `repoPath` from the active project's path: find the project that contains the active workspace, use its `path` field

### Navigation helpers
Add:
- `navigateToLinearAll` — sets view to `"linear-all"`, clears search
- `navigateToGitHub` — sets view to `"github"`, clears search
- `navigateToGitHubAll` — sets view to `"github-all"`, clears search

### Escape handling
Update `handleEscapeKeyDown`:
- `"github-issue-detail"` → go back to previous GitHub list view (github or github-all)
- `"linear-all"` / `"github"` / `"github-all"` → go back to root

### Root view — Linear group
Add a second item after "My Issues":
```tsx
<Command.Item value="Linear All Issues" onSelect={navigateToLinearAll} className={styles.item}>
  <span className={styles.icon}><LinearIcon size={14} /></span>
  <span className={styles.label}>All Issues</span>
  <span className={styles.chevron}><ChevronRight size={14} /></span>
</Command.Item>
```

### Root view — GitHub group
Add after Linear group (when `githubConnected` is true):
```tsx
<Command.Separator className={styles.separator} />
<Command.Group heading="GitHub" className={styles.group}>
  <Command.Item value="GitHub My Issues" onSelect={navigateToGitHub} className={styles.item}>
    <span className={styles.icon}><GitHubIcon size={14} /></span>
    <span className={styles.label}>My Issues</span>
    <span className={styles.chevron}><ChevronRight size={14} /></span>
  </Command.Item>
  <Command.Item value="GitHub All Issues" onSelect={navigateToGitHubAll} className={styles.item}>
    <span className={styles.icon}><GitHubIcon size={14} /></span>
    <span className={styles.label}>All Issues</span>
    <span className={styles.chevron}><ChevronRight size={14} /></span>
  </Command.Item>
</Command.Group>
```

### Breadcrumb
Update breadcrumb to show for `"linear-all"`, `"github"`, `"github-all"` views too:
- `"linear"` → "Linear — My Issues"
- `"linear-all"` → "Linear — All Issues"
- `"github"` → "GitHub — My Issues"
- `"github-all"` → "GitHub — All Issues"

### Search input placeholder
Update placeholder logic:
- `"linear"` / `"linear-all"` → "Search issues..."
- `"github"` / `"github-all"` → "Search issues..."

### List views
- `view === "linear"` → `<LinearIssuesView allTeamIds={allTeamIds} onSelectIssue={...} />`
- `view === "linear-all"` → `<LinearIssuesView allTeamIds={allTeamIds} allIssues onSelectIssue={...} />`
- `view === "github"` → `<GitHubIssuesView repoPath={repoPath} onSelectIssue={...} />`
- `view === "github-all"` → `<GitHubIssuesView repoPath={repoPath} allIssues onSelectIssue={...} />`

### Detail views
- `view === "issue-detail"` → existing `<IssueDetailView .../>` (Linear)
- `view === "github-issue-detail"` → `<GitHubIssueDetailView repoPath={repoPath} issueNumber={selectedGitHubIssueNumber} .../>`

### Wide palette
Update `paletteWide` class condition to include `"github-issue-detail"`.

### Reset
On close, also reset `selectedGitHubIssueNumber`.

## Files to touch
- `src/components/CommandPalette/types.ts` — extend PaletteView union
- `src/components/CommandPalette/LinearIssuesView.tsx` — add allIssues prop
- `src/components/CommandPalette/CommandPalette.tsx` — add GitHub state, navigation, views, breadcrumbs, and "All Issues" for both providers
