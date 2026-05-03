---
title: Native app menu — Check for Updates… item
status: done
priority: medium
assignee: sonnet
blocked_by: [5]
---

# Native app menu — Check for Updates…

Replace `{ role: "appMenu" }` in `electron/app-lifecycle.ts` with an explicit submenu so we can insert "Check for Updates…" between "About" and "Services".

## Required changes

In `electron/app-lifecycle.ts` around line 249–303, replace the `{ role: "appMenu" }` entry with an explicit `app` submenu that mirrors macOS defaults:

```ts
{
  label: app.name,
  submenu: [
    { role: "about" },
    ...(app.isPackaged
      ? [
          { type: "separator" as const },
          {
            label: "Check for Updates…",
            click: () => checkForUpdates(),
          },
        ]
      : []),
    { type: "separator" },
    { role: "services" },
    { type: "separator" },
    { role: "hide" },
    { role: "hideOthers" },
    { role: "unhide" },
    { type: "separator" },
    { role: "quit" },
  ],
}
```

Import `checkForUpdates` from `./updater` at the top of the file.

When `!app.isPackaged`, the "Check for Updates…" item and its preceding separator are omitted (Q12).

## Files to touch
- `electron/app-lifecycle.ts`

## Acceptance
- Packaged build: `Manor → Check for Updates…` appears between "About Manor" and "Services". Clicking it triggers a check; toast feedback appears (already wired via ticket 5).
- Dev build: no "Check for Updates…" item, but all other appMenu items still present.
- `pnpm lint` and typecheck pass.

## REQUIRED: Commit your work

When your implementation is complete, you MUST create a git commit. This is not optional.

Run:
  git add -A
  git commit -m "feat(adr-141): Native app menu — Check for Updates… item"

Replace NNN with the ADR number and use the exact ticket title as the commit message body.
Do not push.
