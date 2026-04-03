---
title: Lazy-load xterm.js in GitHubNudge
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Lazy-load xterm.js in GitHubNudge

GitHubNudge is a non-essential UI element that currently eagerly imports `@xterm/xterm` (Terminal), `@xterm/addon-fit` (FitAddon), and the xterm CSS. These are heavy dependencies that should only load when the user clicks "Install".

## Changes

In `src/components/GitHubNudge.tsx`:

1. Remove the top-level imports:
   ```tsx
   // Remove these:
   import { Terminal } from "@xterm/xterm";
   import { FitAddon } from "@xterm/addon-fit";
   import "@xterm/xterm/css/xterm.css";
   ```

2. Dynamic-import inside `startInstall` callback:
   ```tsx
   const startInstall = useCallback(async () => {
     setPhase("installing");
     phaseRef.current = "installing";

     // Lazy-load xterm
     const [{ Terminal }, { FitAddon }] = await Promise.all([
       import("@xterm/xterm"),
       import("@xterm/addon-fit"),
     ]);
     // Also load the CSS
     import("@xterm/xterm/css/xterm.css");

     // ... rest of the function unchanged
   ```

3. Remove the `Terminal` type from the `useRef<Terminal | null>` — change it to `useRef<InstanceType<typeof import("@xterm/xterm").Terminal> | null>` or simply `useRef<any>(null)` since the ref is only used internally and never exposed. Alternatively, keep the type import: `import type { Terminal } from "@xterm/xterm"` — type imports are erased at build time and don't affect the bundle.

## Files to touch
- `src/components/GitHubNudge.tsx` — move xterm imports into startInstall, keep type-only import for Terminal
