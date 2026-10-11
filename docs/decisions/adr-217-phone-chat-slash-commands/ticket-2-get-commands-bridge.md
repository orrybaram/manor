---
title: Built-in command list and chat.getCommands bridge method
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Built-in command list and chat.getCommands bridge method

ADR-217 D3 and D4.

## Built-ins (D4)
- New `electron/chat-mirror/builtin-commands.ts`. It exports `type ChatCommand = { name: string; description: string; source: "builtin" | "skill"; interactive?: boolean }` and `BUILTIN_COMMANDS: readonly ChatCommand[]`, seeded from the ADR's starting set. Give each a one-line description.
- Check the list against the installed Claude Code if possible (`claude --version`; the `/help` output lists commands). Drop names that don't exist and record the checked version in the header comment. If you can't check, say so in the header.
- Also export `isInteractiveCommand(name: string): boolean`, which the phone uses (ticket 4). Make sure the renderer can import it: this file must not import node modules.

## Mirror (D3)
- `PaneMirror` gains `lastSkills: ChatSkill[]`. In `consume`, after parsing, if `m.parser.hasSkillListing()` set `m.lastSkills = m.parser.skills()` (only when non-empty).
- `reset(m, path)` must **not** clear `lastSkills`: it survives `/clear` and resume in the same pane. `closePane` with no watcher deletes the mirror, and the skills go with it. That's fine.
- New `async getCommands(paneId): Promise<ChatCommands>`. Resolve/ensure/usePath/read exactly as `getHistory` does, and return `host-offline` on `readError`. Then:
  - `skills = m.parser.hasSkillListing() ? m.parser.skills() : m.lastSkills`
  - `skillsKnown = m.parser.hasSkillListing() || m.lastSkills.length > 0`
  - Merge `BUILTIN_COMMANDS` with skills mapped to `{ source: "skill" }`. A skill with the same name replaces the built-in. Sort by name.
- Export `type ChatCommands = { ok: true; commands: ChatCommand[]; skillsKnown: boolean } | { ok: false; reason: ChatUnavailableReason }`.

## Bridge
- `electron/bridge/handlers/chat.ts`: add `chatGetCommands(ctx, paneId)` (`assertString`) and register `getCommands: method(chatGetCommands)` next to `getHistory`, under the "A read" comment. Not audited.
- Re-export `ChatCommand` and `ChatCommands` from `src/electron.d.ts` next to the other chat wire types. Check the phone's `window.electronAPI.chat.getCommands` type-checks (types are inferred from the handler table; follow how `getHistory` is typed). Check `src/bridge/unavailable.ts` in case chat methods need a browser fallback entry.

## Tests
`electron/chat-mirror/__tests__/mirror.test.ts`:
- `getCommands` returns built-ins plus skills from a transcript with a listing.
- With no listing yet, `skillsKnown: false` and built-ins only.
- After the agent's transcript path changes to a file with no listing, the previous skills are still returned (`lastSkills`) with `skillsKnown: true`.
- A skill named like a built-in wins.
- A read failure gives `host-offline`.

## Files to touch
- `electron/chat-mirror/builtin-commands.ts` — new
- `electron/chat-mirror/mirror.ts` — `lastSkills`, `getCommands`, types
- `electron/bridge/handlers/chat.ts` — `getCommands` method
- `src/electron.d.ts` — type re-exports
- `electron/chat-mirror/__tests__/mirror.test.ts` — cases above
