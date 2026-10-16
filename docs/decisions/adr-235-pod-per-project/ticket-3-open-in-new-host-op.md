---
title: openInNewHost — name, recipe, host, wait, clone
status: done
priority: critical
assignee: opus
blocked_by: [1]
---

# openInNewHost — name, recipe, host, wait, clone

ADR-235 D3. New `electron/projects/new-host-for-project.ts`, exposed as the
`projects.openInNewHost` IPC (`localOnly`).

1. **Factor out** the body of `hostsAddRecipeHost`
   (`electron/bridge/handlers/hosts.ts`) into a function that both it and
   this op call. The function takes optional `profileId` and `displayName`
   and returns `hostId`. Keep the existing IPC's behaviour unchanged.
2. **Name.** Take the repo name from `repoUrl`, `toDirSlug` it, and make it
   DNS-label-safe: lowercase `[a-z0-9-]`, starting with a letter, cut so
   that `kubernetes-<ns>-<name>` is at most 64 characters and matches the
   template's `NAME_PATTERN`. If a recipe dir or another host of the profile
   already uses the name, add `-2`, `-3`, … Pure helper with unit tests.
3. `createRecipeFromTemplate(profile.templateId, {...profile.values, name})`,
   then write `idleStopMinutes` into the `recipe.json` (via
   `readRecipe`/`writeRecipe` in `recipes.ts`).
4. Add the host with `profileId`, display name = repo name.
5. `await backendRegistry.ensureConnected(hostId)`. Then, if
   `host-adoption.ts` has an adoption in flight for the host, await it.
   Expose a `whenAdopted(hostId)` promise there if none exists. This makes
   `remote.owns(hostId)` true before the clone, so the clone takes the
   host-owned path.
6. Clone: without `sourceProjectId`, `projectManager.cloneProject({hostId,
   repoUrl, targetDir: "~/code/<slug>", name})`; with it,
   `projectManager.transferProject(sourceProjectId, hostId, "copy")`. A
   `needsInput` result is returned as `{ok:false, stage:"clone", …}` with the
   plan, so the renderer can open the existing fallback dialog.
7. Set `forProject` to the new project id, and broadcast `projects:changed`.

Return `{ok:false, stage:"up"|"clone", hostId, error}` on failure, and
**never destroy**. Add an optional `retryFrom` input (`{hostId, stage}`) that
skips steps 2–4 and resumes.

Tests with the fakes in `electron/projects/test-fakes.ts`: happy path, name
collision, up failure keeps host, clone failure keeps host and marks nothing,
retry from clone, and Set up on joins the group.

## Files to touch
- `electron/projects/new-host-for-project.ts` (new) + test
- `electron/bridge/handlers/hosts.ts` — factor out add-recipe-host
- `electron/bridge/handlers/projects.ts` — `projectsOpenInNewHost`
- `electron/backend/host-adoption.ts` — `whenAdopted` if missing
- preload + electronAPI types
