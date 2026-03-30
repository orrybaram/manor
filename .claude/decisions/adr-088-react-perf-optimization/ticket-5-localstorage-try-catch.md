---
title: Wrap unprotected localStorage access in try-catch
status: done
priority: medium
assignee: haiku
blocked_by: []
---

# Wrap unprotected localStorage access in try-catch

localStorage can throw in restricted environments (private browsing, storage quota exceeded, disabled by policy). Two components access it without protection.

## Changes

### GitHubNudge.tsx (line 47-48)

**Before:**
```tsx
const [dismissed, setDismissed] = useState(
  () => localStorage.getItem(STORAGE_KEY) === "true",
);
```

**After:**
```tsx
const [dismissed, setDismissed] = useState(() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
});
```

### GitHubNudge.tsx (line 65-66)

**Before:**
```tsx
setDismissed(true);
localStorage.setItem(STORAGE_KEY, "true");
```

**After:**
```tsx
setDismissed(true);
try {
  localStorage.setItem(STORAGE_KEY, "true");
} catch {
  // ignore — dismissal still works in memory
}
```

### DeleteWorktreeDialog.tsx (line 18-19)

**Before:**
```tsx
const [deleteBranchChecked, setDeleteBranchChecked] = useState(
  () => localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true",
);
```

**After:**
```tsx
const [deleteBranchChecked, setDeleteBranchChecked] = useState(() => {
  try {
    return localStorage.getItem("manor:deleteBranchOnWorktreeRemove") === "true";
  } catch {
    return false;
  }
});
```

### DeleteWorktreeDialog.tsx (lines 47-50)

**Before:**
```tsx
onChange={(e) => {
  setDeleteBranchChecked(e.target.checked);
  localStorage.setItem(
    "manor:deleteBranchOnWorktreeRemove",
    String(e.target.checked),
  );
}}
```

**After:**
```tsx
onChange={(e) => {
  setDeleteBranchChecked(e.target.checked);
  try {
    localStorage.setItem(
      "manor:deleteBranchOnWorktreeRemove",
      String(e.target.checked),
    );
  } catch {
    // ignore
  }
}}
```

## Files to touch
- `src/components/GitHubNudge.tsx` — wrap 2 localStorage calls in try-catch
- `src/components/DeleteWorktreeDialog.tsx` — wrap 2 localStorage calls in try-catch
