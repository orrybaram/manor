---
title: Jev client, folder-suggestion logic and typesafe bridge namespace
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Jev client, folder-suggestion logic and typesafe bridge namespace

Read `docs/decisions/adr-210-jev-folder-suggestion/index.md` first (sections 1 and 2 of the Decision).

## 1. `electron/typesafe.ts` — `TypeSafeManager`

Model this on `LinearManager` in `electron/linear.ts`: its token storage (lines ~60-100) and its `graphql()` fetch (~413-450).

- Key storage:
  - `saveKey(key)`, `getKey(): string | null`, `clearKey()`, `isConnected()`.
  - Encrypt with `safeStorage` and store at `typesafeKeyFile()`. Add that helper to `electron/paths.ts` next to `linearTokenFile()`; it returns `path.join(manorDataDir(), "typesafe-key.enc")`.
- `export const JEV_MODEL = "jev-1.13.0"` and `const BASE_URL = "https://api.typesafe.ai"`.
- `verify(): Promise<void>`:
  - Sends `GET /v1/models` with `Authorization: Bearer <key>`.
  - Throws `TypeSafe API error: <status> <statusText>` when the response isn't ok.
- `choice({ state, instructions, options }: { state: unknown; instructions: string; options: Record<string, string> })`:
  - Returns `Promise<{ choice: string; probabilities: Record<string, number>; confidence: number }>`.
  - Request: `POST /v1/systemone` with body `{ model: JEV_MODEL, state, questions: { pick: { type: "choice", instructions, criteria: options } } }`.
  - Throws when there is no key, or when there are more than 255 options.
- Timeouts and retries:
  - Every request uses `signal: AbortSignal.timeout(5000)`.
  - Retry 429 and 529 up to 2 times, sleeping 250 ms and then 500 ms. Any other non-ok status throws immediately.
- Parse the reply defensively:
  - `answers.pick` must be an object, and `choice` must be one of the option keys; otherwise throw.
  - Coerce `confidence` and the probabilities with `Number(...)`. Missing probabilities become 0.

## 2. `electron/folder-suggestion.ts` — pure, no I/O

- `export const NO_FOLDER = "__none__"` and `export const MIN_CONFIDENCE = 0.6`.
- `buildFolderQuestion(project: ProjectInfo, draft: { name: string; branchName?: string; agentPrompt?: string })` returns `{ state, instructions, options } | null`.
  - Return `null` when `project.folders` is empty or `draft.name.trim()` is empty.
  - **Options** map each folder id to a description: `Folder "<parent path / name>". Contains workspaces: a, b, c`.
    - Take members from `project.workspaces` where `ws.folderId === folder.id`, capped at 10 names. Use each workspace's display name; check `WorkspaceInfo` in `electron/projects/types.ts` for the field.
    - Omit the "Contains" clause when a folder has no members.
  - Add `[NO_FOLDER]: "Fits none of these folders"`.
  - **State** is `{ workspaceName, branchName, agentPrompt }`, with `agentPrompt` sliced to 2000 chars and blank fields omitted.
  - **Instructions:** "Which sidebar folder should this new workspace be filed under? Folders group related workspaces; judge by what the folder's existing workspaces are about."
- `interpretFolderAnswer(answer, project)` returns `{ folderId, confidence } | null`.
  - Return `null` when the choice is `NO_FOLDER`, `confidence < MIN_CONFIDENCE`, or the folder id no longer exists.

## 3. Bridge namespace `typesafe`

New file `electron/bridge/handlers/typesafe.ts`, following `electron/bridge/handlers/integrations.ts`:

- `typesafeIsConnected(ctx)`
- `typesafeConnect(ctx, apiKey)`: run `assertString`, save the key, then `await verify()`. If that fails, clear the key and rethrow, same as `linearConnect`.
- `typesafeDisconnect(ctx)`
- `typesafeSuggestFolder(ctx, projectId, draft)`:
  - Validate the arguments with `electron/ipc-validate.ts` helpers.
  - Find the project the way other handlers in `handlers/projects.ts` do.
  - Run `buildFolderQuestion`, then `choice`, then `interpretFolderAnswer`.
  - **Never throws.** When the key is missing, the question is null, or any error occurs, return `null`, and log errors with the main-process logger used nearby.

Export the table:

```ts
export const typesafe = {
  isConnected: method(typesafeIsConnected),
  connect: method(typesafeConnect, { localOnly: true, secretFirstArg: true }),
  disconnect: method(typesafeDisconnect, { localOnly: true }),
  suggestFolder: method(typesafeSuggestFolder),
};
```

Wiring:

- `electron/bridge/handlers.ts`: import the table and add it to `flatten({...})`.
- `electron/ipc/types.ts`: add `typesafeManager: TypeSafeManager` to `HostDeps`.
- `electron/app-lifecycle.ts`: construct the manager near `new LinearManager()` (~line 449) and pass it in deps (~line 773). Fix any other places that construct `HostDeps`; tests and fakes will fail typecheck until they include it.
- `electron/bridge/local-only.ts`: add `"typesafe.connect"` and `"typesafe.disconnect"` to `LOCAL_ONLY_METHODS`.
- `src/bridge/unavailable.ts`: add those two to the browser-unavailable union and answers, mirroring `"linear.connect"`.

## 4. Tests (vitest)

- `electron/typesafe.test.ts`, mocking the way `electron/linear.test.ts` does: `electron` safeStorage, `node:fs`, `fetch` via `vi.stubGlobal`. Cover:
  - The request body and headers.
  - Retry on 429 then success.
  - Giving up after 2 retries.
  - No retry on 401.
  - An unknown `choice` throws.
  - No key throws.
- `electron/folder-suggestion.test.ts`. Cover:
  - The option descriptions include member names, capped at 10.
  - The `__none__` option is present.
  - `null` for no folders or an empty name.
  - `interpretFolderAnswer` threshold, `__none__`, and stale id.

Run `pnpm typecheck` and `pnpm vitest run electron/typesafe.test.ts electron/folder-suggestion.test.ts`.

## Files to touch
- `electron/typesafe.ts`: new manager
- `electron/typesafe.test.ts`: new
- `electron/folder-suggestion.ts`: new pure module
- `electron/folder-suggestion.test.ts`: new
- `electron/paths.ts`: `typesafeKeyFile()`
- `electron/bridge/handlers/typesafe.ts`: new handler table
- `electron/bridge/handlers.ts`: register namespace
- `electron/bridge/local-only.ts`: local-only entries
- `src/bridge/unavailable.ts`: browser answers
- `electron/ipc/types.ts`: `HostDeps.typesafeManager`
- `electron/app-lifecycle.ts`: construct and inject
