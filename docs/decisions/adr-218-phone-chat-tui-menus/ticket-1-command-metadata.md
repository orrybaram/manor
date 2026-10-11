---
title: Command metadata says when a menu opens
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Command metadata says when a menu opens

ADR-218 D1. Read the ADR first.

- In `electron/chat-mirror/builtin-commands.ts`, add the optional `argSkipsMenu` and `choices` fields to `ChatCommand`, with doc comments as in the ADR. Update `BUILTIN_COMMANDS` per the D1 table: add `effort` and `fast`, drop `agents`, set `argSkipsMenu` on `model`, `effort`, `fast`, `config`, `resume`, `add-dir`, `mcp`, and add `choices` to `model` / `effort` / `fast`, with short human labels (e.g. "Sonnet") and one-line descriptions.
- Confirm the values against the installed Claude Code: `strings -n 6 ~/.local/share/claude/versions/<current> | grep 'name:"effort"'` etc., and `claude --help` for the model aliases. Drop any choice the binary doesn't support. Update the header comment with the version you checked against and how.
- Export `opensMenu(command: ChatCommand | undefined, name: string, args: string): boolean` from the same file (no imports there: the renderer imports it). Rule: interactive (the command's flag, or the built-in's if `command` is undefined) AND (`args.trim() === ""` OR not `argSkipsMenu`). Keep `isInteractiveCommand` if it's still used elsewhere, or remove it.
- In `src/components/phone/ChatPane/slash-commands.ts`, add `splitCommand(text): { name: string; args: string } | null` (the args are the trimmed rest after the first word). `firstWordCommand` can call it.
- `useSlashCommands.isInteractive(name)` → `opensMenu(name: string, args: string)`, using the fetched command if present.
- `ChatComposer.tsx` `send()`: use `splitCommand(sent)` and `slash.opensMenu(name, args)` in place of the current `isInteractive` check. Keep the `/clear` handling. The composer still calls `setPaneChatView(paneId, "terminal")` for now (ticket 3 replaces that).
- `SlashCommandMenu.tsx`: the "Opens in terminal" tag stays for interactive commands without `choices`. For commands with `choices`, show no tag.
- Unit tests: extend `src/components/phone/ChatPane/__tests__/slash-commands.test.ts` for `splitCommand`, and add tests for `opensMenu` (bare, with args, a command without `argSkipsMenu` but with args, an unknown name, a skill overriding a built-in that isn't interactive).

## Files to touch
- `electron/chat-mirror/builtin-commands.ts`
- `src/components/phone/ChatPane/slash-commands.ts`
- `src/components/phone/ChatPane/useSlashCommands.ts`
- `src/components/phone/ChatPane/ChatComposer.tsx`
- `src/components/phone/ChatPane/SlashCommandMenu.tsx`
- `src/components/phone/ChatPane/__tests__/slash-commands.test.ts`
- `electron/chat-mirror/__tests__/` — a test for `opensMenu` if it fits better there
