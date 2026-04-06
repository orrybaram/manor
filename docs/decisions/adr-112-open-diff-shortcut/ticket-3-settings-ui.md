---
title: Add diff settings toggle to General Settings
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Add diff settings toggle to General Settings

Add a toggle in the General Settings page for the "open diff in new panel" preference.

## Tasks

### 1. Add Diff section to GeneralSettingsPage

In `src/components/settings/GeneralSettingsPage.tsx`, add a new section after the existing "Code Editor" section (after the closing `</Stack>` around line 42, but before the outer closing `</Stack>`):

```tsx
<Stack gap="xs">
  <div className={styles.sectionTitle}>Diff</div>
  <label className={styles.notifRow}>
    <span>Open diff in new panel</span>
    <Switch
      checked={preferences.diffOpensInNewPanel}
      onCheckedChange={(checked) => set("diffOpensInNewPanel", checked)}
    />
  </label>
  <div className={styles.fieldHint}>
    When enabled, the diff view opens in a new side-by-side panel instead
    of a tab in the current panel.
  </div>
</Stack>
```

## Files to touch
- `src/components/settings/GeneralSettingsPage.tsx` — add Diff section with toggle
