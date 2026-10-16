---
title: Install the chosen agent CLIs onto the home volume
status: done
priority: medium
assignee: sonnet
blocked_by: [7, 8]
---

# Install the chosen agent CLIs onto the home volume

ADR-234 D11 (slice 3).

- Templates gain an `agents` field (`type: "choice"` multi, or a dedicated
  `type: "agents"`; Claude Code on by default, Codex off) → `MANOR_AGENTS`
  in `recipe.json`. The Connect step renders checkboxes.
- Dockerfile: `ENV PATH=/home/manor/.local/bin:$PATH`; remove the commented
  agent `RUN` lines, point at the field instead.
- `up.sh` (both templates), after the container/pod is up: for each agent in
  `MANOR_AGENTS`, if its binary is missing, print `manor-stage: Installing
  Claude Code` and run `npm i -g --prefix "$HOME/.local" <pkg>` as `manor`
  via exec. A failed install is a warning on stderr, not a failed `up`.
- Docs + tests.

## Files to touch
- `docker/host-image/Dockerfile`, `docker/host-image/README.md`
- `electron/backend/providers/recipe-templates/{docker,kubernetes,types}.ts`
- `src/components/settings/HostsPage/StartHostForm.tsx`
- `docs/hosts/recipes.md`, tests
