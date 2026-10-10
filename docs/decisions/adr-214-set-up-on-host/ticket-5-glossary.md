---
title: Glossary and ADR cross-references
status: todo
priority: low
assignee: haiku
blocked_by: [4]
---

# Glossary and ADR cross-references

## Steps
1. Add these entries to `CONTEXT.md`, in the existing format (bold term, definition, then an `_Avoid_:` line):
   - **Project**: a repo, set up on one or more **Hosts**, with at most one checkout per host. In code, a lone project is a group of one (ADR-192, ADR-214). _Avoid_ in UI copy: group, member, linked project.
   - **Set up on**: putting a project's repo on another host, by cloning it or adopting an existing checkout of the same origin. It is the only way a project gains a host (ADR-214). _Avoid_: copy to, move to, link, clone onto.
   - **Remove from host**: dropping one host's checkout from a project in Manor without deleting files. A "move" is set up on the new host, then remove from the old one. _Avoid_: unlink, move.
   - Add a relationship bullet: "A **Project** is set up on one or more **Hosts**; each **Workspace** lives on exactly one of them."
2. In `docs/decisions/adr-213-one-click-project-transfer/index.md`, add a line under the title: "Amended by ADR-214: Copy to / Move to became Set up on / Remove from host."

## Files to touch
- `CONTEXT.md`
- `docs/decisions/adr-213-one-click-project-transfer/index.md`
