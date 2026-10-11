---
title: One greeting helper for dashboard and phone
status: done
priority: low
assignee: haiku
blocked_by: [10]
---

# One greeting helper for dashboard and phone

`greetingFor` in `src/components/phone/phone-empty-state.ts:8-13` re-implements `greeting()` from `src/components/sidebar/HomeDashboard/format.ts:22` with different cutoffs (afternoon ends 18:00 vs 17:00; dashboard has "Burning the midnight oil" / "Working late").

Do: delete `greetingFor`; use the dashboard's `greeting(at: number)` everywhere (move it to a neutral shared module such as `src/lib/greeting.ts` and import from both). Update `PhoneEmptyWorkspace.tsx` and tests. Also check `recentStatus` in `phone-empty-state.ts:34-45`: an `active` agent falls to the default "Paused" label — give `active` a correct label (e.g. "Working") matching how the rest of the app labels it.

## Files to touch
- `src/components/phone/phone-empty-state.ts` (+test)
- `src/components/phone/PhoneEmptyWorkspace.tsx`
- `src/components/sidebar/HomeDashboard/format.ts`
- `src/lib/greeting.ts` (new)
