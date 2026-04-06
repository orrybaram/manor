---
type: adr
status: accepted
database:
  schema:
    status:
      type: select
      options: [todo, in-progress, review, done]
      default: todo
    priority:
      type: select
      options: [critical, high, medium, low]
    assignee:
      type: select
      options: [opus, sonnet, haiku]
  defaultView: board
  groupBy: status
---

# ADR-111: Release Script with LLM Changelog Generation

## Context

The current release process is manual and fragmented:
1. Manually bump version in `package.json`
2. Commit with `chore: bump version to X.Y.Z`
3. Create a git tag `vX.Y.Z` and push
4. CI workflow (`.github/workflows/release.yml`) builds, signs, notarizes, and publishes

There is no changelog generation. GitHub Releases are published with no body/notes. Users have no way to see what changed between versions without reading raw git log.

## Decision

Create a `scripts/release.mjs` script that orchestrates the full release flow locally:

1. **Accept version** as a CLI argument (e.g., `node scripts/release.mjs 0.4.0`)
2. **Validate** the version format and ensure the tag doesn't already exist
3. **Generate changelog** by:
   - Getting the git log since the previous tag
   - Piping commit messages to `claude` CLI with a prompt to produce a clean, user-facing changelog (grouped by category: features, fixes, etc.)
4. **Prepend** the new version's changelog to `CHANGELOG.md` (creating it if it doesn't exist)
5. **Bump** `package.json` version via `pnpm pkg set version=X.Y.Z`
6. **Commit** all changes: `chore: release vX.Y.Z`
7. **Tag** with `vX.Y.Z`
8. **Push** commit and tag to remote

Additionally, update the CI workflow to set the generated changelog as the GitHub Release body by reading the relevant section from `CHANGELOG.md`.

The `claude` CLI will be invoked with `--print` mode and a system prompt that instructs it to produce a concise, categorized changelog from raw commit messages. The script will use `execSync` for simplicity.

A `release` script entry will be added to `package.json` for convenience: `pnpm release 0.4.0`.

## Consequences

- **Better**: Every release gets human-readable release notes automatically
- **Better**: Single command to release — less error-prone than manual steps
- **Better**: Cumulative `CHANGELOG.md` provides a history of all changes
- **Tradeoff**: Requires `claude` CLI to be installed locally for changelog generation
- **Tradeoff**: LLM output is non-deterministic — changelog quality may vary, but user can review before push
- **Risk**: The script pushes tags, which triggers CI. A `--dry-run` flag will be included for safety

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
