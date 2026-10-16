---
title: Sign-in section in the profile editor
status: in-progress
priority: high
assignee: sonnet
blocked_by: [2, 9]
---

# Sign-in section in the profile editor

ADR-235 D9, the UI half (split from ticket 9). It uses ticket 9's `hostProfiles.setSignIn / removeSignIn / restartPods` IPC.

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


## Files to touch
- `src/components/settings/HostsPage/ProfileEditorDialog.tsx` / `StartHostForm.tsx`
- `src/components/settings/HostsPage/host-settings-text.ts` — copy
- `src/store/host-profile-store.ts`

## Notes from ticket 9
- The IPC: `hostProfiles.setSignIn(profileId, input)`, `removeSignIn(profileId, which)`, `restartPods(profileId) → {restarted}`.
- Show "Restart running pods to use it" after any set or remove.
