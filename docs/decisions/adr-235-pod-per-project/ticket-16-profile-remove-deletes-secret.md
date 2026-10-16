---
title: Removing a profile deletes its sign-in Secret
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Removing a profile deletes its sign-in Secret

Decided 2026-10-15 after review. Removing a profile today leaves
`manor-signin-<profileId>` in the cluster, tokens included, and no screen can
reach it any more.

- `hostProfiles.remove` (`electron/bridge/handlers/host-profiles.ts`): when
  the profile is kubernetes and has any `signIn` metadata, delete the Secret
  first (`signin.ts`: add `deleteSignInSecret(profile)`, `kubectl delete secret
  <name> --ignore-not-found`, with the same context/namespace validation and
  redaction as the rest of the module).
  - If the delete fails, don't remove the profile. Throw an error that says the
    cluster couldn't be reached, so the user can retry, or remove it after
    fixing access.
- The remove confirm (`REMOVE_PROFILE_TEXT` / `ProfileActions` on the Hosts
  page): when the profile has sign-in set, add "Its sign-in tokens are deleted
  from <namespace>. Running pods keep them until they restart."
- Tests: the delete in the spawn args, no profile removed when the delete
  fails, no kubectl call when there is no signIn, and the confirm copy.

## Files to touch
- `electron/backend/providers/recipe-templates/signin.ts` + `electron/backend/__tests__/recipe-signin.test.ts`
- `electron/bridge/handlers/host-profiles.ts`
- `src/components/settings/HostsPage/host-settings-text.ts`, `HostsPage.tsx` (ProfileActions) + test
