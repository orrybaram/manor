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

# ADR-011: GitHub Actions Release Workflow

## Context

Manor has auto-update infrastructure (ADR-010) but no CI/CD pipeline. Releases are entirely manual — you'd have to build locally, manually create a GitHub Release, and upload artifacts. macOS auto-updates also require code-signed and notarized builds, which is impractical to do by hand every time.

We need a single GitHub Actions workflow that handles the full release pipeline: build, sign, notarize, and publish to GitHub Releases. The workflow should be triggered by pushing a version tag (e.g., `v0.2.0`).

## Decision

Create a GitHub Actions workflow `.github/workflows/release.yml` that:

1. **Triggers on** version tags (`v*`)
2. **Runs on** `macos-latest` (macOS runner for native builds + notarization)
3. **Steps**:
   - Checkout code
   - Setup Node.js + pnpm
   - Install dependencies (`pnpm install`)
   - Build and publish via `electron-builder --publish always`
   - electron-builder handles: code signing (via `CSC_LINK` + `CSC_KEY_PASSWORD`), notarization (via `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`), uploading artifacts to the GitHub Release created from the tag

4. **Required repository secrets** (documented in workflow comments):
   - `CSC_LINK` — base64-encoded .p12 certificate
   - `CSC_KEY_PASSWORD` — certificate password
   - `APPLE_ID` — Apple ID email for notarization
   - `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password for notarization
   - `APPLE_TEAM_ID` — Apple Developer Team ID

5. **Also add** macOS entitlements file (`build/entitlements.mac.plist`) required for notarized Electron apps (hardened runtime, allow JIT for node-pty).

6. **Update** `package.json` build config to reference the entitlements file and enable `hardenedRuntime` + `gatekeeperAssess: false`.

## Consequences

- **Better**: One-command releases — just `git tag v0.2.0 && git push --tags`
- **Better**: Builds are properly signed and notarized, enabling auto-updates on macOS
- **Better**: Reproducible builds on CI, not dependent on local dev machine state
- **Tradeoff**: Requires Apple Developer Program membership ($99/yr) and setting up secrets in the GitHub repo
- **Tradeoff**: macOS-only for now (no Windows/Linux targets) — can be extended later
- **Risk**: macOS CI runners are slower and more expensive than Linux runners

## Tickets

<div data-type="database" data-path="." data-view="board"></div>
