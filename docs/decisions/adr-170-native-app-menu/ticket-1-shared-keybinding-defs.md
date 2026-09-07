---
title: DOM-free keybinding registry with accelerator conversion and multi-listener KeybindingsManager
status: done
priority: critical
assignee: sonnet
blocked_by: []
---

# DOM-free keybinding registry with accelerator conversion

The Electron main process needs the keybinding registry to render shortcuts in the native menu. `src/lib/keybindings.ts` cannot be imported from main today because it touches `navigator` and `KeyboardEvent`. Split the pure half into a leaf module, following the `src/lib/home-path.ts` precedent (see its header comment).

## Steps

1. Create `src/lib/keybinding-defs.ts` with **zero imports** and no DOM references. Move these from `src/lib/keybindings.ts` verbatim: `KeyCombo`, `KeybindingCategory`, `CATEGORY_LABELS`, `CATEGORY_ORDER`, `KeybindingDef`, the `metaCombo` helper, `DEFAULT_KEYBINDINGS`, `serializeCombo`, `deserializeCombo`. Move `platformDefaults` too, but make its `platform` parameter **required** (`platformDefaults(platform: string)`); the mac check stays `platform.toLowerCase().includes("mac")`.
2. Add two defs to `DEFAULT_KEYBINDINGS`, category `workspace`, placed right after `new-workspace`:
   - `next-workspace`, label "Next Workspace", `metaCombo("ArrowDown", false, false, true)` (⌃⌘↓)
   - `prev-workspace`, label "Previous Workspace", `metaCombo("ArrowUp", false, false, true)` (⌃⌘↑)
3. Add `resolveBindings(overrides: Record<string, string>, platform: string): { bindings: Record<string, KeyCombo>; overriddenIds: Set<string> }` to the new module. It is exactly `buildDefaultBindings` + `mergeOverrides` from `src/store/keybindings-store.ts`. Replace those two private functions in the store with calls to `resolveBindings(overrides, navigator.platform)` (the store may keep a `defaultBindings` for its initial state via `resolveBindings({}, navigator.platform).bindings`).
4. Add `comboToAccelerator(combo: KeyCombo, platform: "mac" | "other"): string` to the new module. Output is Electron accelerator syntax:
   - Modifier order and names: `Ctrl`, `Alt`, `Shift`, then `Cmd` on mac / `Super` otherwise, joined with `+`.
   - Key mapping: single characters are upper-cased (`d` → `D`, `=` and `[` and `\` and `,` and `.` pass through); `" "` → `Space`; `ArrowUp/Down/Left/Right` → `Up/Down/Left/Right`; `Escape` → `Esc`; `Enter` → `Return`; `Backspace`, `Delete`, `Tab`, `Home`, `End`, `PageUp`, `PageDown`, `F1`–`F24` pass through unchanged.
   - Examples: `{key:"d",meta,shift}` → `Cmd+Shift+D`; `{key:"ArrowDown",meta,ctrl}` → `Ctrl+Cmd+Down`; `{key:"\\",meta,alt}` → `Alt+Cmd+\`.
5. In `src/lib/keybindings.ts`: delete the moved code and add `export * from "./keybinding-defs";` at the top. Keep `getPlatform`, `comboMatches`, `comboFromEvent`, `ARROW_GLYPHS`, `formatCombo`. Add a thin `platformDefaults(platform?: string)` wrapper is **not** needed — instead update the two call sites that call `platformDefaults()` with no argument (grep for them; the store is one) to pass `navigator.platform`. Every existing importer of `../lib/keybindings` must keep compiling unchanged.
6. `electron/keybindings.ts`: make `onChange` multi-listener. Replace `changeCallback` with a `Set<(overrides) => void>`; `onChange(cb)` adds and returns an unsubscribe function; `set`/`reset`/`resetAll` notify every listener. Update the JSDoc. The existing caller in `electron/ipc/misc.ts:204` needs no change (it ignores the return value).
7. Tests in `src/lib/__tests__/keybinding-defs.test.ts` (node environment, import only the new module):
   - `comboToAccelerator` for the three examples above plus `Escape`, `Enter`, `" "`, and a non-mac combo (`Ctrl+Shift+D`).
   - `resolveBindings` merges an override, marks it overridden, and leaves the others at defaults; on a non-mac platform defaults use `ctrl` not `meta`.
   - `DEFAULT_KEYBINDINGS` ids are unique and include `next-workspace` / `prev-workspace`.
   - A module-import guard: `import("../keybinding-defs")` resolves without `window`/`navigator` defined (vitest default env is node, so simply importing at top level is the guard; add a comment saying so).
   - `electron/keybindings.test.ts`: `onChange` supports two listeners, both fire on `set`, and the returned unsubscribe stops one of them. Use a temp dir for `dataDir` (see `electron/__tests__/setup-isolated-home.ts`; `KeybindingsManager` accepts `dataDir`).
8. Run `npx tsc --noEmit -p tsconfig.json` (must stay at zero errors), `npx tsc --noEmit -p tsconfig.electron.json` (no new errors beyond the 13 pre-existing ones in files you did not touch), `npx vitest run src/lib electron/keybindings.test.ts`, and `pnpm lint` on the files you touched.

## Files to touch
- `src/lib/keybinding-defs.ts` — new, DOM-free registry + `resolveBindings` + `comboToAccelerator`
- `src/lib/keybindings.ts` — re-export the leaf, keep only DOM helpers
- `src/store/keybindings-store.ts` — use `resolveBindings`
- `electron/keybindings.ts` — multi-listener `onChange`
- `src/lib/__tests__/keybinding-defs.test.ts` — new
- `electron/keybindings.test.ts` — new
