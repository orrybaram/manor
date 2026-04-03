---
title: Create GitHub Actions release workflow
status: done
priority: high
assignee: sonnet
blocked_by: [1]
---

# Create GitHub Actions release workflow

Create `.github/workflows/release.yml`.

## Requirements

The workflow should:

1. **Trigger** on tags matching `v*` (e.g., `v0.1.0`, `v1.0.0-beta.1`)

2. **Environment**: `macos-latest`

3. **Steps** (in order):
   - Checkout with `actions/checkout@v4`
   - Setup Node.js with `actions/setup-node@v4` (use node version 20)
   - Setup pnpm with `pnpm/action-setup@v4`
   - Install dependencies: `pnpm install`
   - Build and publish: `pnpm run build && electron-builder --publish always`

4. **Environment variables** for the build+publish step:
   - `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` — for uploading to GitHub Releases
   - `CSC_LINK: ${{ secrets.CSC_LINK }}` — base64 .p12 certificate
   - `CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}` — certificate password
   - `APPLE_ID: ${{ secrets.APPLE_ID }}` — for notarization
   - `APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}` — for notarization
   - `APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}` — for notarization

5. **Add comments** at the top of the workflow file documenting which secrets need to be configured and how to obtain them (brief instructions for creating the .p12 cert, app-specific password, etc.)

6. **Permissions**: Give the workflow `contents: write` permission so `GITHUB_TOKEN` can create releases.

## Files to touch
- `.github/workflows/release.yml` — new file
