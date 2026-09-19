---
title: The new-session screen on the phone
status: done
priority: high
assignee: sonnet
blocked_by: [1, 2]
---

# The new-session screen on the phone

Wire the two new server capabilities into the client: pick a workspace, type a
prompt, launch, and land in the new session's transcript.

Read `src/remote-client/main.ts`'s header comment first and obey it. The two
rules that matter here: **a screen is mounted once and then patched** (never
rebuild a node a thumb might be on, never rebuild an input someone is typing in),
and **a capability gate removes rather than disables** — a device without
`identity.canSend` must be shown no way to launch, because the route is not in
its table either.

## Behaviour

- `mountList()` gains a `+` button in the `bar`, appended only when
  `identity.canSend === true`, and removed when not (mirror how `mountDetail`
  adds/removes `actions` and `composer` in its `update()`). Tapping it shows the
  new screen.
- `mountNewSession()` — a screen like the others, returning `{ update, dispose }`:
  - a `Back` button to `backToList()`;
  - loads `GET /workspaces` once on mount through the existing `api()` helper,
    and renders projects as sections with their workspaces as rows: name (fall
    back to the branch), branch as the row's meta, and `main` flagged the way the
    sidebar flags it;
  - a row whose `path` matches the `workspacePath` of any agent in the client's
    `agents` list is marked as already having a session (a short meta note, e.g.
    "session running") — computed client-side, no new request;
  - tapping a row selects it (single selection, visibly marked);
  - a prompt field — reuse the composer's input conventions
    (`autocapitalize`/`autocomplete` off) with a placeholder like "What should the
    agent do?" — and a `Launch` button, disabled until a workspace is selected and
    the prompt is non-empty;
  - empty/loading/error states: "Loading…", and an `.empty` box if the list comes
    back with no projects.
- `Launch` goes through the existing `confirmAction()` sheet, not a bespoke one:
  title names the workspace, `detail` says an agent process will be started in it,
  `code` is the prompt, verb `Launch`.
- On confirm: `POST /agents` with `{ workspacePath, prompt, confirmed: true }`.
  The gate in ticket 2 rejects a request without `confirmed`, so this is not
  optional.
- On success the response is a `StartedAgent` — `{ tabId, paneId, workspacePath }`,
  no agent id. So: `setNotice("Launched.", "ok")`, then `await loadAgents()` and
  match `paneId` against `agents[].paneId`. Found → `openSession(agent)`. Not
  found yet (the agent row is created by the hook relay a moment later) → go back
  to the list and let the poll surface it; do not spin, and do not leave the user
  on a dead screen.
- `api()` already handles 401 and non-2xx by notice, so a failed launch needs no
  bespoke error path.

## Styles

`src/remote-client/styles.css` — the palette and tokens are the desktop's and
stay so. Reuse existing classes (`.sessions`, `.session`, `.empty`, `.composer`,
`.sheet`) wherever the shape already fits; add only what is genuinely new (the
project section heading, the selected-row mark, the `+` button in the bar). Tap
targets stay finger-sized.

## Files to touch
- `src/remote-client/main.ts` — `mountNewSession()`, the `+` in `mountList()`, the launch call and the land-in-session hop
- `src/remote-client/styles.css` — section heading, selected row, `+` button
