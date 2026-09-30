/**
 * ADR-202 §2: every task tracker, by provider. Callers look the adapter up
 * here instead of branching on `"github" | "linear"`.
 */

import type { TaskProvider } from "../tasks";
import { githubTracker } from "./github";
import { linearTracker } from "./linear";
import type { TaskTracker } from "./types";

export type { TaskTracker, TrackerQuery, TrackerScope } from "./types";

export const TRACKERS: Record<TaskProvider, TaskTracker> = {
  github: githubTracker,
  linear: linearTracker,
};

/** The adapter for `provider`. */
export function trackerFor(provider: TaskProvider): TaskTracker {
  return TRACKERS[provider];
}

/** The status query key of `provider` — shared with the Sidebar so both read one cached answer. */
export function TRACKER_STATUS_KEY(provider: TaskProvider): readonly unknown[] {
  return TRACKERS[provider].statusQuery().queryKey;
}
