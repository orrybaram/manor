---
title: TranscriptAdapter seam and agentKind on PaneAgent
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# TranscriptAdapter seam and agentKind on PaneAgent

ADR-224 D1. A pure refactor plus one new unavailable reason. Behaviour for
Claude panes must not change: every existing chat-mirror test passes unchanged
(apart from fixtures that build a `PaneAgent`, which gain `agentKind: "claude"`).

1. Create `electron/chat-mirror/adapters/types.ts` with `TranscriptAdapter` and
   `TranscriptLineParser` exactly as in the ADR. `createParser` takes an
   optional `{ child?: boolean }` (ticket 3 uses it; ignore it for now).
   `childTranscriptPath` can return null for now.
2. `electron/chat-mirror/adapters/claude.ts`: `claudeAdapter`, wrapping
   `TranscriptParser` from `../transcript`.
3. `electron/chat-mirror/adapters/index.ts`: `adapterFor(kind)`. Only
   `"claude"` → `claudeAdapter`; everything else → null. Import `AgentKind`
   from wherever `agent-persistence.ts` gets it (`"claude" | "opencode" |
   "codex" | "pi"`).
4. `mirror.ts`:
   - `PaneAgent` gains `agentKind: AgentKind`.
   - `resolve()` answers `{ok:false, reason:"unsupported-agent"}` when
     `adapterFor` is null. Check this after `no-agent` and before
     `no-transcript`.
   - `PaneMirror` holds its adapter, and `reset` builds the parser with
     `adapter.createParser()` instead of `new TranscriptParser()`. Type the
     parser as `TranscriptLineParser`.
   - When the agent kind changes, treat it like a path change (reset).
   - Add `"unsupported-agent"` to `ChatUnavailableReason`.
5. `electron/app-lifecycle.ts` (the `agentForPane` near line 750): pass
   `agentKind: agent.agentKind`.
6. Renderer: find where `ChatUnavailableReason` is mirrored (`src/electron.d.ts`)
   and where the phone renders the reasons (`src/components/phone/ChatPane/`),
   and add copy for `unsupported-agent`: "Chat isn't available for this agent
   yet."
7. Tests:
   - `adapters/__tests__/index.test.ts`: claude resolves; codex, opencode and
     pi resolve to null.
   - In `mirror.test.ts`: a codex agent answers `unsupported-agent` from
     `getHistory`.

## Files to touch
- `electron/chat-mirror/adapters/{types,claude,index}.ts` — new
- `electron/chat-mirror/mirror.ts` — agentKind, adapter-built parser, new reason
- `electron/app-lifecycle.ts` — pass agentKind
- `src/electron.d.ts` — reason type if mirrored there
- `src/components/phone/ChatPane/ChatPane.tsx` — copy for the new reason
- `electron/chat-mirror/__tests__/mirror.test.ts`, `electron/chat-mirror/adapters/__tests__/index.test.ts`
