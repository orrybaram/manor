---
title: Install refractor and create syntax utility
status: done
priority: high
assignee: sonnet
blocked_by: []
---

# Install refractor and create syntax utility

## Tasks

1. Install `refractor` package via npm
2. Create `src/components/workspace-panes/DiffPane/syntax.ts` with:
   - Import `refractor` from `refractor/lib/core`
   - Register common languages: javascript, typescript, tsx, jsx, css, markup (HTML), json, python, go, rust, bash, yaml, markdown
   - Export `extToLang(filePath: string): string | null` — maps file extension to refractor language name
   - Export `tokenize(code: string, lang: string): HastNode[]` — wraps `refractor.highlight()`, returns HAST nodes. Returns plain text node if language unknown.

## Files to touch
- `package.json` — add `refractor` dependency
- `src/components/workspace-panes/DiffPane/syntax.ts` — new file
