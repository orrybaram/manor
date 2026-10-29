/**
 * What an automation's page edits, and how a draft becomes what main
 * accepts. Pure, apart from reading the viewer's zone for a new one.
 */

import {
  DEFAULT_MISSED_GRACE_MINUTES,
  MAX_KEEP_LAST,
  type AutomationInput,
  type AutomationWorkspace,
} from "../../../lib/automations";
import type { AutomationDetail } from "../../../lib/automation-views";
import { localTimezone } from "../../../lib/cron-describe";
import type { ProjectInfo } from "../../../store/project-store";
import type { AutomationHost } from "./useAutomations";

/** What the page edits: an automation's input, and the host it is on. */
export interface Draft extends AutomationInput {
  enabled: boolean;
  hostId: string;
}

export function draftOf(detail: AutomationDetail, hostId: string): Draft {
  return {
    hostId,
    name: detail.name,
    enabled: detail.enabled,
    schedule: detail.schedule,
    projectId: detail.projectId,
    prompt: detail.prompt,
    agentKind: detail.agentKind,
    workspace: detail.workspace,
    missedGraceMinutes: detail.missedGraceMinutes,
  };
}

export function projectsOn(projects: readonly ProjectInfo[], hostId: string): ProjectInfo[] {
  return projects.filter((p) => p.hostId === hostId);
}

/** The defaults a new automation starts from: "Weekdays at 09:00", here, paused. */
export function newDraft(host: AutomationHost, projects: readonly ProjectInfo[]): Draft {
  return {
    hostId: host.hostId,
    name: "New automation",
    enabled: false,
    schedule: { cron: "0 9 * * 1-5", timezone: localTimezone() },
    projectId: projectsOn(projects, host.hostId)[0]?.id ?? "",
    prompt: "",
    agentKind: "claude",
    workspace: { mode: "new" },
    missedGraceMinutes: DEFAULT_MISSED_GRACE_MINUTES,
  };
}

/**
 * Keep last cleared: an update patch drops it with `keepLast: null` (the
 * host merges a workspace patch), which is not an `AutomationWorkspace`.
 */
export const KEEP_ALL = { mode: "new", keepLast: null } as unknown as AutomationWorkspace;

/** A workspace with a cleared Keep last as main stores it: no `keepLast`. */
export function storedWorkspace(workspace: AutomationWorkspace): AutomationWorkspace {
  if (workspace.mode === "new" && workspace.keepLast == null) return { mode: "new" };
  return workspace;
}

/** A draft as create takes it, and as the page validates it. */
export function inputOf(draft: Draft): AutomationInput {
  const { hostId: _hostId, ...input } = draft;
  return { ...input, workspace: storedWorkspace(input.workspace) };
}

/** Keep last's text as a count: undefined when cleared, null when it isn't 1 to 20. */
export function parseKeepLast(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= MAX_KEEP_LAST ? n : null;
}

/** The hourly preset's minute: null unless a whole number 0 to 59. */
export function parseMinute(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null;
  const n = Number(text);
  return n <= 59 ? n : null;
}
