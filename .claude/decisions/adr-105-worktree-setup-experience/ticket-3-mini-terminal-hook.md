---
title: Extract shared MiniTerminal component from GitHubNudge
status: done
priority: high
assignee: opus
blocked_by: []
---

# Extract shared MiniTerminal component from GitHubNudge

`GitHubNudge.tsx` already has a working ephemeral terminal pattern (lines 97-203). Extract this into a reusable `MiniTerminal` component + `useMiniTerminal` hook so both GitHubNudge and the new WorkspaceSetupView can use it.

## Implementation

### 1. Create `src/hooks/useMiniTerminal.ts`

Extract the terminal lifecycle from `GitHubNudge.tsx` into a hook. The hook manages:
- xterm `Terminal` creation with `FitAddon` (dynamic imports, same as GitHubNudge lines 101-105)
- PTY session creation via `window.electronAPI.pty.create()` with a caller-provided `sessionId`
- Output subscription via `window.electronAPI.pty.onOutput()`
- Exit detection via `window.electronAPI.pty.onExit()`
- Cleanup: `pty.close()` + `term.dispose()` on unmount

```typescript
interface UseMiniTerminalOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  sessionId: string;           // unique ID, e.g. "gh-install-123" or "setup-/path"
  cwd: string | null;          // working directory for the PTY
  command: string | null;      // command to write after shell init; null = don't start
  interactive?: boolean;       // default false — if true, wires onData → pty.write
  onOutput?: (data: string) => void;  // optional callback on each output chunk (for pattern matching like GitHubNudge's auth detection)
  onExit?: () => void;         // called when PTY exits
}

interface UseMiniTerminalReturn {
  start: () => Promise<void>;  // call to create terminal + PTY
  cleanup: () => void;         // manual cleanup
  termRef: React.RefObject<Terminal | null>;
}
```

Key differences from GitHubNudge's inline version:
- `interactive` option controls whether user input is forwarded (GitHubNudge needs this for `gh auth login`; setup view does not)
- `onOutput` callback lets the consumer react to output (GitHubNudge checks for "Logged in as"; setup view doesn't need this)
- `onExit` callback replaces the inline exit handler
- `command` is written to the PTY after first output (same "first prompt" detection as GitHubNudge line 172-177), or after a 500ms delay if no output arrives
- Theme is read from `useThemeStore` internally (same `themeToXterm` helper, moved into this file or a shared util)

### 2. Create `src/components/ui/MiniTerminal.tsx`

A thin wrapper component that provides the container div and calls the hook:

```typescript
interface MiniTerminalProps {
  sessionId: string;
  cwd: string | null;
  command: string | null;
  interactive?: boolean;
  onOutput?: (data: string) => void;
  onExit?: () => void;
  autoStart?: boolean;        // default true — start immediately on mount
  className?: string;
}
```

The component:
- Renders a `<div ref={containerRef}>` with terminal styling (background from theme, rounded corners)
- Calls `useMiniTerminal` and auto-starts if `autoStart` is true
- Applies the caller's `className` for sizing

### 3. Refactor GitHubNudge to use MiniTerminal

Replace the inline terminal code in `GitHubNudge.tsx` (lines 60-203) with `<MiniTerminal>`:

```tsx
<MiniTerminal
  sessionId={`gh-install-${Date.now()}`}
  cwd={null}
  command="brew install gh && clear && gh auth login"
  interactive={true}
  onOutput={(data) => {
    if (data.includes("Logged in as") || data.includes("already logged in")) {
      finishAuth();
    }
  }}
  onExit={() => { /* check gh status fallback */ }}
/>
```

This significantly simplifies GitHubNudge — all the Terminal/FitAddon imports, paneIdRef, termRef, fitRef, cleanupRef, and the `startInstall` callback body can be removed.

### 4. Move `themeToXterm` to shared location

The `themeToXterm` helper (GitHubNudge lines 17-42) is needed by the hook. Move it to `src/terminal/config.ts` or `src/utils/theme.ts` and import from both places.

## Files to touch
- `src/hooks/useMiniTerminal.ts` — new hook extracted from GitHubNudge
- `src/components/ui/MiniTerminal.tsx` — new shared component wrapping the hook
- `src/components/sidebar/GitHubNudge.tsx` — refactor to use `<MiniTerminal>`
- `src/terminal/config.ts` or similar — move `themeToXterm` helper
