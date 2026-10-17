---
title: "Fix: relink after a refusal retries while the host's relay comes back"
status: in-progress
priority: high
assignee: sonnet
blocked_by: [3]
---

# Fix: relink after a refusal retries while the host's relay comes back

Found by the e2e evidence run. After "Reset pairing keys", the host's `RelayRoom.reset` revokes devices, which closes the phone with 4401, before it resets its identity and redials the relay. The phone's single automatic `relinkAll` reaches `HostPairingLinks.linkOne` while `status.relay.connected` is still false (true again about 370ms later), so nothing is minted. That uses up the once-per-room ask in `src/bridge/install-web.ts`, and the phone stays "Only through <desktop>" until its next desktop hello. The reset check passed only 3 of 9 runs.

Fix it on the phone. A 4401 on a room still triggers at most one *sequence* of relinks per room per page load, but the sequence retries:
- call `relinkAll()` immediately
- if no new pairing appeared, call it again after 2s, then 6s, then 15s (a small constant array of delays), and stop at the first attempt that adds a pairing
- "No new pairing" means the set of `listPairings()` room ids after the attempt holds no room that wasn't held before the sequence started.

A device the desktop has blocked gets only these 4 cheap asks per load (`linkOne` returns at the block check), so there's no loop. Timers must not keep running for a room whose sequence already succeeded. Keep the code small and match the file's style. Update the 4401 header bullet in `install-web.ts` and the ADR-238 D1 wording isn't yours to edit (the orchestrator does docs).

## Tests
`src/bridge/__tests__/install-web-relay.test.ts`, with fake timers:
- (a) the first ask returns nothing, the second (after 2s) returns a BOX link → BOX is stored and there's no third ask
- (b) every ask returns nothing → exactly 4 asks, then none
- (c) the existing "a second 4401 on the same room in the same load sends no further ask" still holds (no new sequence)

## Files to touch
- `src/bridge/install-web.ts`
- `src/bridge/__tests__/install-web-relay.test.ts`
