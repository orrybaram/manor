---
title: Add version define, status bar logo button, and About modal
status: done
priority: medium
assignee: sonnet
blocked_by: []
---

# Add version define, status bar logo button, and About modal

Implement the full feature in one ticket since all pieces are tightly coupled.

## Steps

### 1. Expose version via Vite define
In `vite.config.ts`, add a `define` block to inject `__APP_VERSION__`:
```ts
import pkg from './package.json';
// ...
define: { __APP_VERSION__: JSON.stringify(pkg.version) },
```
Add a type declaration so TypeScript knows about it — add `declare const __APP_VERSION__: string;` to `src/vite-env.d.ts` or a new `src/globals.d.ts`.

### 2. Create AboutModal component
Create `src/components/AboutModal.tsx` and `src/components/AboutModal.module.css`.

The modal should:
- Use Radix `Dialog.Root` / `Dialog.Portal` / `Dialog.Overlay` / `Dialog.Content` pattern
- Use overlay/dialog styles similar to the confirm dialog pattern in `Sidebar.module.css`
- Display ManorLogo at ~48px size centered
- Display "Manor" as the app name
- Display version as `v{__APP_VERSION__}`
- Show a divider
- List "Inspired by" section with clickable links that call `window.electronAPI.shell.openExternal(url)`

Inspiration projects and their GitHub repos (look up actual URLs):
- superset
- supacode
- react-grab
- libghostty
- xterm
- t3code
- agent deck

Style the modal to be compact (~320-360px wide), centered, with the same animation and backdrop pattern used by confirm dialogs.

### 3. Add logo button to StatusBar
In `src/components/StatusBar.tsx`:
- Import `ManorLogo` and `AboutModal`
- Add `useState` for `aboutOpen`
- Render a small clickable logo (~12px) in the `.right` div
- Render `<AboutModal open={aboutOpen} onOpenChange={setAboutOpen} />`

Style the logo button in `StatusBar.module.css`:
- `cursor: pointer`
- `opacity: 0.5` default, `opacity: 1` on hover
- `transition: opacity 150ms`
- Size constrained to ~12px

## Files to touch
- `vite.config.ts` — add `define` for `__APP_VERSION__`
- `src/vite-env.d.ts` or new `src/globals.d.ts` — type declaration for `__APP_VERSION__`
- `src/components/AboutModal.tsx` — new component
- `src/components/AboutModal.module.css` — new styles
- `src/components/StatusBar.tsx` — add logo button and modal
- `src/components/StatusBar.module.css` — logo button styles
