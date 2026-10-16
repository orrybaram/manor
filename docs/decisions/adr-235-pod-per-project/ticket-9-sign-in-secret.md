---
title: "Sign new pods in for me" — namespace Secret, envFrom, gh setup-git
status: todo
priority: high
assignee: opus
blocked_by: [2, 8]
---

# "Sign new pods in for me" — namespace Secret, envFrom, gh setup-git

ADR-235 D9. Kubernetes profiles only.

**Main** (new `electron/backend/providers/recipe-templates/signin.ts`):
- `writeSignIn(profile, { github?: {source:"gh"} | {source:"pasted", token},
  claude?: {token} })`:
  - for `source:"gh"`, run `gh auth token` locally (execFile, login PATH);
  - build the Secret YAML (`manor-signin`, keys `GH_TOKEN`,
    `CLAUDE_CODE_OAUTH_TOKEN`, base64 data);
  - pipe it to `kubectl --context <ctx> -n <ns> apply -f -` on **stdin**.
    The token must never be in argv or logs, and the recipe runner's output
    capture must not see it.
  - Merge with existing keys: read the Secret's key names only (`-o
    jsonpath='{.data}'` keys), not their values.
- `removeSignIn(profile, which)`: patch out a key, or delete the Secret when
  it is empty.
- `restartPods(profile)`: `kubectl delete pod <name>-0` for each running host
  of the profile.
- Save `signIn.{github,claude} = { setAt, source }` on the profile. No token
  is stored on the laptop.
- IPC: `hostProfiles.setSignIn / removeSignIn / restartPods` (`localOnly`).

**Template** (`kubernetes.ts`):
- Container `envFrom: [{secretRef: {name: manor-signin, optional: true}}]`.
- In the hooks `exec` step: `if [ -n "${GH_TOKEN:-}" ]; then gh auth
  setup-git; fi`. Run it as the container user; it is idempotent.

**UI** (profile editor, ticket 2): a "Sign new pods in for me" section, off
by default, only for kubernetes profiles:
- GitHub: radio "Use this computer's GitHub sign-in" / "Paste a token" (a
  password-type input, not EmojiInput; suggest a fine-grained token).
- Claude: a paste field for the `claude setup-token` output.
- Status rows "Set <date> · from this computer", with Replace / Remove.
- The warning copy from D9 ("Anyone who can read Secrets in <namespace> or
  open a terminal in its pods can use these…"), always visible while the
  option is on.
- After a change: "Restart running pods to use it" [Restart N pods].

Verify that `claude` honours `CLAUDE_CODE_OAUTH_TOKEN` for the health
check's auth probe (`electron/backend/health-check.ts`). Adjust the probe if
it only looks at credential files.

Tests: Secret YAML builder (no token in argv: assert the spawn args), merge
and remove logic with a fake kubectl, and template content.

## Files to touch
- `electron/backend/providers/recipe-templates/signin.ts` (new) + test
- `electron/backend/providers/recipe-templates/kubernetes.ts`
- `electron/bridge/handlers/host-profiles.ts`
- `electron/backend/health-check.ts` (probe, if needed)
- `src/components/settings/HostsPage/ProfileEditorDialog.tsx` / `StartHostForm.tsx`
