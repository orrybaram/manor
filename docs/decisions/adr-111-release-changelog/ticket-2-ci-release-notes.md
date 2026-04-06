---
title: Update CI workflow to use changelog as release notes
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Update CI workflow to use changelog as release notes

Update `.github/workflows/release.yml` so the GitHub Release includes the changelog for the current version as its body.

## Implementation

In the "Publish release" step, extract the current version's section from `CHANGELOG.md` and pass it as the release body.

Replace the current publish step:
```yaml
- name: Publish release
  run: gh release edit "$GITHUB_REF_NAME" --draft=false
```

With:
```yaml
- name: Publish release
  run: |
    VERSION="${GITHUB_REF_NAME#v}"
    # Extract the section for this version from CHANGELOG.md
    # Match from "## [VERSION]" until the next "## [" or end of file
    NOTES=$(sed -n "/^## \[$VERSION\]/,/^## \[/{/^## \[$VERSION\]/p; /^## \[/!p}" CHANGELOG.md 2>/dev/null || echo "")
    if [ -n "$NOTES" ]; then
      gh release edit "$GITHUB_REF_NAME" --draft=false --notes "$NOTES"
    else
      gh release edit "$GITHUB_REF_NAME" --draft=false
    fi
```

This way, if `CHANGELOG.md` has an entry for the version, it shows up in the GitHub Release. If not (fallback), the release is still published without notes.

## Files to touch
- `.github/workflows/release.yml` — update the "Publish release" step
