---
title: Name the sign-in Secret per profile
status: in-progress
priority: high
assignee: sonnet
blocked_by: [9, 3]
---

# Name the sign-in Secret per profile

ADR-235 D9 (amended). Follow-up from ticket 9: two profiles on the same
context and namespace share the one `manor-signin` Secret, so removing a
token through one profile also removes it from the other, while the other's
metadata still says it's set.

- `signin.ts`: the Secret is named `manor-signin-<profileId>`. The profile id
  is `hp-` plus hex, which makes a valid DNS name; assert that.
- `kubernetes.ts`: `envFrom.secretRef.name` comes from
  `${MANOR_K8S_SIGNIN_SECRET:-manor-signin}` (the default covers recipes
  written before this change). Keep `optional: true`.
- `new-host-for-project.ts` (ticket 3): write `MANOR_K8S_SIGNIN_SECRET` into the
  recipe env for a kubernetes profile. Also accept it in the template's
  `recipe()` validation if env keys are checked there.
- Tests: the Secret name in the spawn args, the template default, and the
  recipe env written by `openInNewHost`.

## Files to touch
- `electron/backend/providers/recipe-templates/signin.ts` + `electron/backend/__tests__/recipe-signin.test.ts`
- `electron/backend/providers/recipe-templates/kubernetes.ts` + `electron/backend/__tests__/recipe-templates.test.ts`
- `electron/projects/new-host-for-project.ts` + test
