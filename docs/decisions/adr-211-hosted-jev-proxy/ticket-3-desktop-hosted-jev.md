---
title: Desktop calls hosted Jev; remove user key; preference toggle
status: todo
priority: high
assignee: opus
blocked_by: [1]
---

# Desktop calls hosted Jev; remove user key; preference toggle

Read Decisions 4–6 of `docs/decisions/adr-211-hosted-jev-proxy/index.md`. Also read ADR-210 (`docs/decisions/adr-210-jev-folder-suggestion/`) for what exists today.

## 1. `electron/jev.ts`: `JevClient` (replaces `electron/typesafe.ts`)

- The constructor takes optional deps for tests: `{ identityStore?: () => RelayIdentityStore; baseUrl?: () => string; fetch?: typeof fetch }`.
  - **`baseUrl`:** default to the relay-URL helper in `electron/remote-control/relay/connector.ts`, the function at ~line 154 that returns `MANOR_RELAY_URL` or `DEFAULT_RELAY_URL`. Check whether importing `connector.ts` pulls in heavy modules: ADR-205 §3 keeps relay modules lazily loaded. If it does, move `DEFAULT_RELAY_URL` and the helper into a tiny module (e.g. `electron/remote-control/relay/url.ts`), re-export them from `connector.ts`, and import from there.
  - **`identityStore`:** default to a lazily created `new RelayIdentityStore()`. `identity.ts` only imports fs, safeStorage and relay-crypto, so a static import is fine.
- `async suggest({ state, options }): Promise<{ choice: string; confidence: number } | null>`:
  1. `const identity = store.load()`.
  2. Sign `{ state, options }` with `ts = Date.now()` using `signJevRequest` from `src/lib/relay-crypto`, then `wipe(identity)` in a `finally`.
  3. POST JSON `{ v: 1, pub: base64urlEncode(identity.ed25519.pub), ts, sig: base64urlEncode(sig), state, options }` to `${baseUrl}/jev/folder`, with `signal: AbortSignal.timeout(5000)`.
  4. A non-200 response returns `null`. On 200, parse it, and return `null` unless `choice` is a key of `options` and `confidence` is a finite number.
  5. If `EncryptionUnavailableError` is thrown, set an instance flag `disabled = true` and return `null` from then on.
  6. Other errors propagate. The handler catches them.

## 2. `electron/folder-suggestion.ts`

- Remove `instructions` from `FolderQuestion` and `buildFolderQuestion`; the worker owns it now. Leave a one-line comment saying so, pointing at `relay/src/jev.ts`.
- Clamp to the worker's limits so a big project doesn't get a 400:
  - at most 63 folders, plus `__none__`
  - descriptions at most 400 chars (truncate member lists)
  - `workspaceName` and `branchName` at most 200 chars
  - `agentPrompt` at most 2000 chars, as today
- Update `electron/folder-suggestion.test.ts` to match, and add a test for the folder cap.

## 3. Bridge: `typesafe` becomes `jev`

- Rename `electron/bridge/handlers/typesafe.ts` to `jev.ts`, exporting `jev = { suggestFolder: method(jevSuggestFolder) }`.
- `jevSuggestFolder` keeps today's validation and never-throws contract, with two changes:
  - It first returns `null` when `ctx.deps.preferences` (find the right dep name) reports `folderSuggestionsEnabled === false`.
  - It calls `ctx.deps.jevClient.suggest(question)`, then `interpretFolderAnswer`.
- `HostDeps` (`electron/ipc/types.ts`): replace `typesafeManager` with `jevClient: JevClient`. Update `electron/app-lifecycle.ts` accordingly.
- `electron/bridge/handlers.ts`: register `jev` instead of `typesafe`.
- Remove the `typesafe.*` entries from:
  - `electron/bridge/local-only.ts`
  - `src/bridge/unavailable.ts`
  - `electron/bridge/__tests__/caller-class.test.ts`
- Delete `electron/typesafe.ts`, `electron/typesafe.test.ts` and `typesafeKeyFile` in `electron/paths.ts`.
- Add `electron/jev.test.ts`. Use a fake identity store with a generated identity and a mocked fetch. Cover:
  - The request body verifies with `verifyJevRequest`.
  - The private key is wiped after the call.
  - Non-200 returns `null`.
  - An unknown choice returns `null`.
  - `EncryptionUnavailableError` disables the client.

## 4. Preference

- Add `folderSuggestionsEnabled: boolean` to `AppPreferences` and `DEFAULTS` (`true`) in `electron/preferences.ts`, and to the mirror in `src/electron.d.ts`.
- In `src/components/settings/GeneralSettingsPage.tsx`, add a section modeled on "Usage Stats":
  - Title: "Folder Suggestions".
  - Switch: "Suggest folders for new workspaces".
  - Hint: "Uses Jev, provided by Manor. Sends the workspace name, branch, agent prompt and your folder and workspace names to relay.manor.sh and TypeSafe. Nothing is stored."
- Delete `src/components/settings/TypeSafeIntegrationSection.tsx` and its mount in `IntegrationsPage.tsx`.

## 5. Dialog

In `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`:

- Replace the `typesafe.isConnected()` probe and `jevConnected` state with the preference.
  - Find how other renderer code reads `AppPreferences`, probably a preferences store or hook, and use it.
  - Rename `jevConnected` to `suggestionsEnabled` in the component and in `folder-suggestion.ts` (`shouldSuggest`'s gate) and its test.
- Change `window.electronAPI.typesafe.suggestFolder` to `window.electronAPI.jev.suggestFolder`.

## 6. Docs

- `docs/remote-control.md`, section "The Manor relay": add a short paragraph saying the relay also serves `POST /jev/folder` (ADR-211). That route sees folder and workspace names and the agent prompt in cleartext, forwards them to TypeSafe, and doesn't log or store them. Users can turn it off in Settings → General.
- `CONTEXT.md`: if it has a glossary entry style that fits, add "Folder suggestion": Jev's pick of a sidebar folder for a new workspace. Skip this if it doesn't fit.

## Checks

Run `pnpm typecheck`, `pnpm vitest run electron/jev.test.ts electron/folder-suggestion.test.ts electron/bridge src/bridge src/components/sidebar/NewWorkspaceDialog`, and `pnpm knip` if it exists, to catch dead exports left by the removal.

## Files to touch
- `electron/jev.ts`, `electron/jev.test.ts`: new
- `electron/typesafe.ts`, `electron/typesafe.test.ts`: delete
- `electron/paths.ts`: remove `typesafeKeyFile`
- `electron/remote-control/relay/connector.ts` (+ maybe new `url.ts`): relay URL helper
- `electron/folder-suggestion.ts`, `electron/folder-suggestion.test.ts`
- `electron/bridge/handlers/typesafe.ts` → `electron/bridge/handlers/jev.ts`
- `electron/bridge/handlers.ts`, `electron/bridge/local-only.ts`, `src/bridge/unavailable.ts`, `electron/bridge/__tests__/caller-class.test.ts`
- `electron/ipc/types.ts`, `electron/app-lifecycle.ts`
- `electron/preferences.ts`, `src/electron.d.ts`
- `src/components/settings/GeneralSettingsPage.tsx`, `src/components/settings/IntegrationsPage.tsx`, `src/components/settings/TypeSafeIntegrationSection.tsx` (delete)
- `src/components/sidebar/NewWorkspaceDialog/NewWorkspaceDialog.tsx`, `folder-suggestion.ts`, `folder-suggestion.test.ts`
- `docs/remote-control.md`, maybe `CONTEXT.md`
