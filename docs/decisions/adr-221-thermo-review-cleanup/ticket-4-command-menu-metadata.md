---
title: Command menu metadata enum and dead code
status: todo
priority: medium
assignee: sonnet
blocked_by: [2, 3]
---

# Command menu metadata enum and dead code

`electron/chat-mirror/builtin-commands.ts:23-25` encodes three states with two booleans: `interactive` and `argSkipsMenu` (meaningless alone). `opensMenu` (`:111-119`) and `SlashCommandMenu.tsx:53` (`item.interactive && !item.choices`) both rebuild the meaning.

Do:
1. Replace with `menu?: "always" | "bare-only"`. `opensMenu(entry, args)` = `entry.menu === "always" || (entry.menu === "bare-only" && !args)`. Look up `command ?? BY_NAME.get(name)` once (in `useSlashCommands.opensMenu`) so the pure function takes an entry, not `(command | undefined, name, args)`. Update the shared command type that crosses the bridge (find where `interactive` is declared for the renderer) and `SlashCommandMenu.tsx`.
2. Delete dead `isInteractiveCommand` (`builtin-commands.ts:101`) and `firstWordCommand` (`src/components/phone/ChatPane/slash-commands.ts:91`) and their tests.
3. Pure `commandEffect(splitCommand(sent), lookup): "menu" | "clear" | null` in `slash-commands.ts`, replacing the ad-hoc post-send branches in `ChatComposer.sendText` (~96-102: menu handoff start + `CLEAR_COMMANDS` check). Composer switches on the result. Unit test it.
4. `ChatEntryView.tsx`: the task-notification notice row borrows `styles.toolGroupSummary`; give it its own `notice` class in `ChatPane.module.css` (same visual).

## Files to touch
- `electron/chat-mirror/builtin-commands.ts`
- `src/components/phone/ChatPane/slash-commands.ts`
- `src/components/phone/ChatPane/useSlashCommands.ts`
- `src/components/phone/ChatPane/SlashCommandMenu.tsx`
- `src/components/phone/ChatPane/ChatComposer.tsx` (sendText only)
- `src/components/phone/ChatPane/ChatEntryView.tsx`, `ChatPane.module.css`
- related tests under `__tests__/`
