---
title: Show the audit log in Manor
status: todo
priority: medium
assignee: sonnet
blocked_by: []
---

# Show the audit log in Manor

`electron/remote-control/audit.ts` writes an append-only, size-rotated,
0600 `remote-audit.jsonl` with a line per remote send: timestamp, device id and label,
target, interrupt flag, outcome, status, and the length and SHA-256 of the text. Nothing
in the app reads it.

An audit log nobody can read is a compliance gesture. The question it exists to answer —
_did something type into my shell while I was away, and from which device_ — is one a user
will ask in a hurry, probably right after they suspect a token leaked, and right now the
only way to answer it is to find a `.jsonl` file in Application Support and read it by
hand.

- A **Recent remote activity** section in `RemoteControlPage`, newest first, showing time,
  device label, target session, whether it was an interrupt, and the outcome. Read
  through IPC; the renderer never touches the file.
- Show it even when remote control is currently off — the interesting case is looking
  back at a session that has ended.
- Keep the existing privacy property visible rather than silently implied: the row shows
  the text's length and hash, and the UI should say that the text itself is deliberately
  not recorded, so nobody reads the absence as a bug.
- Cap what is read into memory; the file is rotated but can still be large. Tail it.
- Rejected sends matter as much as accepted ones — a run of `rejected` lines is what a
  stolen token looks like. Do not filter them out, and give them enough visual weight to
  notice.

Tests: entries render newest-first; a rejected entry is distinguishable from an accepted
one; the reader tails rather than loading the whole file; no plaintext of any send ever
crosses IPC.

## Files to touch

- `electron/remote-control/audit.ts` — a bounded reader.
- `electron/remote-control/controller.ts` and the IPC surface — expose it.
- `src/store/remote-control-store.ts` — hold the entries.
- `src/components/settings/RemoteControlPage.tsx` — the section.
- `electron/remote-control/__tests__/audit.test.ts` — the reader.
