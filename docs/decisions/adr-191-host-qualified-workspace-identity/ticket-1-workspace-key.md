---
title: Add a workspace key made of host plus path, alongside the old path key
status: done
priority: high
assignee: opus
blocked_by: []
---

# Add a workspace key made of host plus path, alongside the old path key

GitHub issue #238. See ADR-191 §1.

The expand step. Add the key and its helpers. No caller switches over, and no
behavior changes.

- New `src/lib/workspace-key.ts`, pure and import-free so both processes can
  use it: `workspaceKey`, `parseWorkspaceKey`, `isRemoteWorkspaceKey`,
  `ownerHostIdForPath`, `migrateWorkspaceKey`, `migrateWorkspaceKeyedRecord`,
  and the branded `WorkspaceKey` type.
- Local keys are bare paths. Remote keys are `<hostId>:<path>`.
- Migration assigns a bare path to the host of the project that owns it most
  closely, and to local on a tie or when nothing matches.

## Files to touch
- `src/lib/workspace-key.ts`: new, the helpers.
- `src/lib/__tests__/workspace-key.test.ts`: new. Covers build, parse and
  migrate, including two projects on different hosts with the same path.
- `electron/projects/workspace-key.test.ts`: new. Proves the helpers compile
  under `tsconfig.electron.json` and accept main's `ProjectInfo`.
