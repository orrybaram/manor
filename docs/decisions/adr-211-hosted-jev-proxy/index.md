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

# ADR-211: Manor provides Jev through the relay; users bring no key

Amends ADR-210. Its decisions 1 and 3 (a user-entered TypeSafe key and the
Integrations section for it) are replaced. Its decisions 2 and 4 (the folder
question and the dialog behaviour) stand.

## Context

ADR-210 made folder suggestions depend on each user pasting their own
TypeSafe key. The owner wants to provide Jev to users as a courtesy instead.
The key can't ship in the app: an Electron bundle is readable, so a shipped
key is a published key. It has to live on a server Manor runs, and that
server has to stop the key being used as a free general-purpose Jev endpoint.

Manor already runs one server, the relay Worker at `relay.manor.sh` (ADR-206),
and every desktop already has an Ed25519 relay identity
(`electron/remote-control/relay/identity.ts`, `RelayIdentityStore`). The
relay already checks signatures from that key (`verifyHostChallenge` in
`src/lib/relay-crypto/keys.ts`, which the worker imports). That identity is
free to mint, so it isn't an account. It is still a stable handle to
rate-limit by.

The owner's decisions: on by default with an off switch; no
bring-your-own-key path; a global cap of 5,000 calls per UTC day.

## Decision

**1. `POST /jev/folder` on the relay Worker, shaped narrowly.**

- `relay/src/jev.ts` handles the route, and `relay/src/index.ts` sends
  `/jev/folder` to it before the WebSocket routes.
- The TypeSafe key is a wrangler secret, `TYPESAFE_API_KEY`, set with
  `wrangler secret put`. It is never in `wrangler.toml`.
- The worker owns everything that makes a request a Jev request: the model
  (`JEV_MODEL = "jev-1.13.0"`), the question type (`choice`) and the
  instructions text. The client sends only the data.

Request body (JSON, at most 16 KiB):

```json
{ "v": 1, "pub": "<ed25519 pub, base64url>", "ts": 1760000000000, "sig": "<base64url>",
  "state": { "workspaceName": "…", "branchName": "…", "agentPrompt": "…" },
  "options": { "<folderId>": "<description>", "__none__": "Fits none of these folders" } }
```

Validation:

- `options`: 2–64 entries, keys at most 64 chars, descriptions at most 400 chars.
- `state`: only the three known string fields; `workspaceName` and
  `branchName` at most 200 chars each, `agentPrompt` at most 2000.
- Anything else gets a 400.

The reply is `{ "choice": string, "confidence": number }` and nothing more.
If TypeSafe fails, the worker answers 502. It retries 429/529 from TypeSafe
once.

**2. Requests are signed with the relay identity.**

- **Signature:** `sig` is Ed25519 over
  `"manor-jev-v1" ‖ ts (decimal) ‖ sha256(canonical JSON of {state, options})`.
- **Helpers:** add `signJevRequest` and `verifyJevRequest` to
  `src/lib/relay-crypto/keys.ts`, next to the host-challenge pair, using the
  same strict verification. Both the desktop and the worker use them.
- **Freshness:** the worker rejects a `ts` more than 5 minutes from its own
  clock, with 401. It also rejects a bad signature with 401.
- **Replays:** a replay inside the window only spends the same identity's
  rate limit, so the worker doesn't track nonces.

**3. Three limits, checked cheapest first.**

- **Per IP:** a new `JEV_LIMITER` ratelimit binding, 60 per 60 s, keyed `jevip:<ip>`.
- **Per identity:** the same binding, 20 per 60 s, keyed `jevid:<roomIdFor(pub)>`.
  Ratelimit bindings have one limit each, so this is a second binding,
  `JEV_ID_LIMITER`.
- **Global daily cap:** a new singleton Durable Object, `JevBudget`
  (`idFromName("global")`). It keeps a counter keyed by UTC date and refuses
  once the count reaches `JEV_DAILY_CALLS` (a `wrangler.toml` var, `"5000"`).
  It's a new `new_sqlite_classes` migration, tag `v2`.
- Limits answer 429, and a spent budget answers 503. The desktop treats all of
  them as "no suggestion".

**4. The desktop calls the relay, not TypeSafe.**

- `electron/typesafe.ts` is replaced by `electron/jev.ts`, `JevClient`.
  `suggest({ state, options })` posts to `${relayBaseUrl()}/jev/folder`, using
  the existing helper next to `DEFAULT_RELAY_URL` in
  `electron/remote-control/relay/connector.ts` (it honours `MANOR_RELAY_URL`
  for dev).
- To sign, it loads the relay identity through a `RelayIdentityStore` it
  creates lazily. That store creates an identity on first use, and it is the
  same file remote control uses. It zeroes the private key after signing
  (`wipe`).
- If `safeStorage` can't encrypt (`EncryptionUnavailableError`), suggestions
  are off for that session.
- Each request times out after 5 s. There are no retries on the desktop; the
  worker retries.
- The `typesafe` bridge namespace becomes `jev`, with one method:
  `suggestFolder(projectId, draft)`. It is unchanged in contract and never
  throws. `electron/folder-suggestion.ts` keeps building the options and
  state and interpreting the answer; the instructions text moves to the
  worker.

**5. One preference, on by default.**

- `AppPreferences.folderSuggestionsEnabled: boolean`, default `true`. Add it
  to `electron/preferences.ts` and the hand mirror in `src/electron.d.ts`.
- `GeneralSettingsPage` gets a "Suggest folders for new workspaces" switch.
  Its hint reads: "Uses Jev, provided by Manor. Sends the workspace name,
  branch, agent prompt and your folder and workspace names to relay.manor.sh
  and TypeSafe. Nothing is stored."
- `suggestFolder` returns `null` when the preference is off. The dialog checks
  the preference, not `typesafe.isConnected()`.

**6. Removed:**

- `TypeSafeManager` and its key file helper `typesafeKeyFile`
- `typesafe.connect`, `typesafe.disconnect` and `typesafe.isConnected`, with
  their entries in `local-only.ts`, `src/bridge/unavailable.ts` and
  `caller-class.test.ts`
- `TypeSafeIntegrationSection` and its mount

## Consequences

- Folder suggestions work for everyone out of the box, at the owner's cost.
  That cost is bounded by the daily cap: worst case, 5,000 Jev choice calls a
  day.
- The identity limit doesn't stop a determined abuser, who can mint
  identities. The per-IP limit and the global cap are the real ceiling. Abuse
  degrades to "suggestions stop for everyone until UTC midnight", not to an
  unbounded bill. Because the worker fixes the model, instructions and shape,
  the endpoint is useless for anything except picking a folder.
- The relay stops being purely blind for this one route: it sees folder and
  workspace names and agent prompts in cleartext. It doesn't log or store them.
  `docs/remote-control.md` (the section on what the relay can see) has to say
  so.
- A desktop that never turned on remote control will now create a relay
  identity the first time it suggests a folder. The identity is just a key
  file; it doesn't open a room or a socket.
- The relay deploy (`pnpm relay:deploy`, from the release workflow) needs the
  new secret set once: `wrangler secret put TYPESAFE_API_KEY`. Without the
  secret, the route answers 503.
- Users can no longer bring their own key to get past the cap. The owner chose
  this deliberately.

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
