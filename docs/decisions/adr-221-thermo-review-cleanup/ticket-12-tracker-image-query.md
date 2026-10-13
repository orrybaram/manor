---
title: TaskTracker imageQuery and one URL parser
status: done
priority: high
assignee: opus
blocked_by: []
---

# TaskTracker imageQuery and one URL parser

ADR-202 says the task list never branches on provider. The image proxy adds a provider switch in `src/lib/task-images.ts:30-34` (`isTrackerImageUrl(provider, url)`) and a second in `src/components/tasks/TaskDetail/ProxiedImage.tsx:23-40` (`provider === "linear" ? api.linear.proxyImage : api.github.proxyImage`).

Also `task-images.ts:36-43` has a private `httpsUrl()` next to the new `src/lib/http-url.ts` `httpUrl()`, and `electron/remote-forwards.ts:308` `parseHttpUrl` is a third copy.

Do:
1. Add `imageQuery(url): TrackerQuery<string> | null` (null = load directly) to the `TaskTracker` port (find it under `src/lib/trackers/`). GitHub implements via `githubImageFetchUrl`, Linear via `isLinearImageUrl`, memory returns null. Use the existing `TrackerQuery` conventions.
2. `ProxiedImage` = `const q = trackerFor(provider).imageQuery(src)`; no provider knowledge. Delete `isTrackerImageUrl`.
3. `src/lib/http-url.ts` exports `parseHttpUrl(href, base?): URL | null` and an https-only check; `httpUrl`, `task-images.ts` and `electron/remote-forwards.ts` build on it (check electron can import from `src/lib` — follow existing cross-imports; if not allowed, leave remote-forwards and note it).
4. Update `src/lib/task-images.test.ts`, `src/lib/http-url.test.ts`, tracker tests.

## Files to touch
- `src/lib/trackers/*.ts` (port + github, linear, memory)
- `src/lib/task-images.ts` (+test)
- `src/lib/http-url.ts` (+test)
- `src/components/tasks/TaskDetail/ProxiedImage.tsx`
- `electron/remote-forwards.ts`
