---
title: GET /workspaces — the phone's launch-target list
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# GET /workspaces — the phone's launch-target list

Give the phone client the minimum it needs to choose where to launch: project
name, and each visible workspace's path, branch and name. Nothing else.

Add it as a **listener-owned route** in
`electron/remote-control/listener-routes.ts` — the file for rows that exist only
for the phone client — not to `electron/routes/`, and *not* by allowlisting
`GET /projects` (which would ship `agentCommand`, `worktreeStartScript`, Linear
associations and every absolute path on the machine to a phone).

## Shape

```ts
// GET /workspaces → 200
[
  {
    projectId: string,
    projectName: string,
    workspaces: [{ path: string, branch: string, name: string | null, isMain: boolean }],
  },
]
```

Rules:

- Source is `deps.projectManager.getProjects()` (async). It is reachable from a
  listener route because `dispatch()` is handed `getDeps()` — read
  `RouteContext` in `electron/routes/types.ts` and follow the existing rows.
- Filter out workspaces with `hidden === true`. The phone offers what the
  sidebar offers.
- Projects with no visible workspaces are omitted entirely.
- No `projectManager` on `deps` → `503 { error: "Project management is not available" }`,
  matching `electron/routes/context.ts`.
- Preserve the project and workspace order `getProjects()` returns; do not sort.

## Comments

Follow the tone of the file you are editing. The header comment of
`listener-routes.ts` currently enumerates two routes and says "none of them reads
session state" — update it to three and keep that claim true by saying what this
one reads instead (project *configuration*, projected down to four fields, and
why the projection exists rather than `GET /projects`).

## Tests

`electron/remote-control/__tests__/allowlist.test.ts` asserts
`LISTENER_OWN_ROUTES` is *exactly* two rows. Update it to the three, in table
order — that assertion exists to make this change deliberate, so change it, do
not weaken it. Its two neighbouring assertions (listener rows do not shadow the
real table, and are not reachable through the dispatched table) must still pass
unchanged.

Add coverage in `electron/remote-control/__tests__/server.test.ts` following the
`/me` tests already there:

- a paired read-only device gets the list (this is a read; `canSend` is irrelevant);
- the payload contains no key other than the four per workspace and the two per
  project — assert on `Object.keys`, so a future field cannot leak in silently;
- a hidden workspace is absent;
- no token → 401.

## Files to touch
- `electron/remote-control/listener-routes.ts` — the new row, and the header comment
- `electron/remote-control/__tests__/allowlist.test.ts` — the three-row assertion
- `electron/remote-control/__tests__/server.test.ts` — route behaviour and the key-leak assertion
