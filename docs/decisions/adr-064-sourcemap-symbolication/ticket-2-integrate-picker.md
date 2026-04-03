---
title: Integrate symbolication into picker script
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Integrate symbolication into picker script

Wire the sourcemap symbolication module into `electron/picker-script.ts` so that React component stacks show original source file paths.

### Changes

1. **Import the symbolication script string** from `electron/sourcemap-symbolication.ts`

2. **Embed symbolication in the IIFE**: Prepend `SYMBOLICATION_SCRIPT` inside the picker's IIFE so the symbolication functions are available before `getReactFiberInfo` runs. The final exported string should be: `SYMBOLICATION_SCRIPT + PICKER_IIFE`.

3. **Make `getReactFiberInfo` async**: Change from synchronous to async. For each component with a `_debugStack`-derived source:
   - Call `window.__manor_symbolication__.symbolicateFrame(fileName, lineNumber, columnNumber)`
   - If symbolication succeeds, use the resolved `fileName` and `lineNumber`
   - Run `normalizeFileName()` on the result
   - Skip the component from the stack if `isSourceFile()` returns false
   - If symbolication fails, keep the original parsed values (graceful fallback)

4. **Update `onClick` handler**: Make it async, `await getReactFiberInfo(el)` before building the result JSON.

5. **Also handle `_debugSource`**: If `_debugSource.fileName` looks like a bundle path (contains `/_next/`, `chunks/`, etc.), try to symbolicate it too.

### Testing approach
- Manual: pick an element in a Next.js app running in dev mode, verify source paths resolve to actual `.tsx` files with correct line numbers

## Files to touch
- `electron/picker-script.ts` — import symbolication string, make getReactFiberInfo async, update onClick
