---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-210: Integrate Jev and use it to suggest a folder for a new workspace

## Context

Jev is TypeSafe's hosted "System One" decision model (released 2026-09-15).
It doesn't generate text. You give it a `state` and named questions, and it
answers each one: a `choice` among options you define, a `score`, or a yes/no
(`noul`). Every answer carries probabilities. It is far cheaper and faster than
asking a generative LLM to make the same pick, which makes it a good fit for
small decisions Manor makes while the user waits.

The wire format, from Pipecat's reference client (`pipecat.classifiers.jev`)
and third-party docs. TypeSafe's own docs were unreachable:

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`
- body: `{ model: "jev-1.13.0", state: string | object, questions: { <name>: { type: "choice", instructions: string, criteria: { <option>: <description> } } } }`
  (choice allows up to 255 options)
- reply: `{ answers: { <name>: { choice, probabilities: { <option>: number }, confidence } }, usage: { input_tokens, output_tokens } }`
- 429 / 529 mean busy: retry with short backoff. Any other non-200 is a hard failure.
- `GET /v1/models` is a cheap authenticated call, which makes it a good key check.
- The official JS SDK is `@typesafe-ai/sdk` (`TypeSafeClient#systemOne`).

The first use is filing in the New Workspace dialog. A project's sidebar
folders (`WorkspaceFolder { id, name, parentId }`, `ProjectInfo.folders`)
group its workspaces. Today the dialog's folder combobox starts on "No
folder" unless it was opened from a folder's own menu (`initialFolderId`), so
most new workspaces land unfiled and get dragged into place by hand.

## Decision

**1. A small main-process Jev client, keyed like Linear.**
`electron/typesafe.ts` exports `TypeSafeManager`, which mirrors
`LinearManager`:

- The key is encrypted with `safeStorage` at `typesafeKeyFile()` (new helper in
  `electron/paths.ts`, `typesafe-key.enc`).
- It has `saveKey`, `getKey`, `clearKey`, `isConnected` and `verify()` (`GET /v1/models`).
- `choice({ state, instructions, options })` returns `{ choice, probabilities, confidence }`.

It calls `fetch` directly with no SDK dependency, because a single endpoint
doesn't justify a new package. Each request times out after 5 s via
`AbortSignal.timeout`. It retries 429/529 twice (250 ms, then 500 ms) and
throws on anything else. The model id is one constant, `JEV_MODEL = "jev-1.13.0"`.
The key never crosses to the renderer.

**2. Folder suggestion is a pure function plus one bridge method.**
`electron/folder-suggestion.ts` builds the question from a project and the
draft workspace:

- **Options:** each folder's id maps to a description containing its name, its
  parent path and up to 10 names of workspaces already in it. Those member
  names are the strongest signal of what the folder is for. A reserved
  `__none__` option is described as "fits none of these folders".
- **State:** `{ workspaceName, branchName, agentPrompt }`. The agent prompt is
  trimmed to 2,000 chars.
- **Result:** a folder id, or `null`, when any of these hold:
  - the answer is `__none__`
  - `confidence < 0.6`
  - the project has no folders
  - the draft name is empty

The bridge namespace `typesafe` (`electron/bridge/handlers/typesafe.ts`) has:

- `isConnected`
- `connect(apiKey)`: `localOnly` and `secretFirstArg`. It saves the key, then
  calls `verify()`, and clears the key if that fails, the same pattern as
  `linearConnect`.
- `disconnect`: `localOnly`.
- `suggestFolder(projectId, draft)`: returns `{ folderId, confidence } | null`.
  It is never a hard error to the caller. A missing key or a network or API
  failure returns `null` and logs once.

**3. A settings section to enter the key.**
`src/components/settings/TypeSafeIntegrationSection.tsx` is a copy of
`LinearIntegrationSection` that calls `typesafe.connect/disconnect/isConnected`.
It is mounted in `IntegrationsPage`. Having a key connected is the on-switch,
so there is no separate preference.

**4. The dialog suggests without overriding the user.**
In `NewWorkspaceDialog`, once the name (or the agent prompt) settles for
400 ms, the dialog calls `typesafe.suggestFolder` and applies the result. It
does this only while all of these hold:

- the user hasn't touched the folder combobox since the dialog opened
- the dialog wasn't opened with an `initialFolderId`
- the active project has folders
- `typesafe.isConnected()` was true when the dialog opened

A response for a stale draft or project is dropped. While a request is in
flight, an accent shimmer sweeps across the folder combobox; its label is left
alone, and the picked folder simply replaces it. (This replaced an earlier
"Suggested" marker, which was dropped after the feature shipped.) Picking
anything by hand, including "No folder", stops the shimmer and further
suggestions for that dialog session. Submitting never waits on an in-flight
suggestion.

## Consequences

- Most new workspaces land in the right folder with no extra clicks. Users
  without a TypeSafe key see no change.
- This adds a paid third-party dependency. The workspace name, branch and
  agent prompt, plus folder and workspace names, are sent to TypeSafe. The
  settings section has to say so plainly.
- The API shape comes from secondary sources (Pipecat's client, blog posts),
  not TypeSafe's docs. Response parsing is defensive: an unknown `choice` or a
  missing `answers` is treated as no suggestion. `JEV_MODEL` is a single
  constant so it is easy to bump.
- TypeSafe paused new signups in late September 2026. Until that lifts, the
  feature is dormant for anyone without an existing account.
- `TypeSafeManager.choice` is generic, so later uses (labelling tasks, routing
  issues to projects, and so on) reuse it without new plumbing.
- The key can only be set or cleared from the desktop: `connect` and
  `disconnect` are local-only. `suggestFolder` runs in the desktop main
  process, so remote clients that drive the same dialog get suggestions on
  the desktop's key.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
