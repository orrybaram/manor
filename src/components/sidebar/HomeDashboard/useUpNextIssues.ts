import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useProjectStore, type ProjectInfo } from "../../../store/project-store";
import { buildTopLevelEntries, topLevelKeys } from "../../../utils/sidebar-items";
import { ghRepoOf } from "../../../lib/gh-repo";
import {
  primaryMember,
  topUpNextPerProject,
  upNextFromGitHub,
  upNextFromLinear,
  upNextList,
  type UpNextIssue,
} from "../../../lib/home-dashboard";

const PER_PROJECT = 3;
const POLL_MS = 60_000;

/** One Up next row: the ranked issue plus the project it's worked on in. */
export interface UpNextRow {
  issue: UpNextIssue;
  /** The member checkout the issue was listed through — work starts here. */
  project: ProjectInfo;
  /** The top-level entry's display name (the group name for a linked group). */
  entryName: string;
  color: string | null;
}

/** Query keys that already logged a failure — a flaky source logs once, not every minute. */
const loggedFailures = new Set<string>();

/**
 * Run `fetch`, swallowing a failure: Up next skips a source that fails
 * (ADR-194 §1) rather than erroring the whole section.
 */
async function swallow<T>(key: string, fetch: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fetch();
  } catch (err) {
    if (!loggedFailures.has(key)) {
      loggedFailures.add(key);
      console.warn(`[HomeDashboard] Up next source ${key} failed:`, err);
    }
    return [];
  }
}

function flattenResults(results: { data?: UpNextIssue[]; isPending: boolean }[]): {
  issues: UpNextIssue[];
  loading: boolean;
} {
  return {
    issues: results.flatMap((r) => r.data ?? []),
    loading: results.some((r) => r.isPending),
  };
}

type Source = {
  key: string;
  kind: "gh" | "linear";
  entryKey: string;
  member: ProjectInfo;
};

/**
 * Open issues assigned to the user across every top-level entry that no
 * workspace has linked yet, ranked for Home's Up next (ADR-194 §1). One
 * GitHub and (when linked and connected) one Linear query per entry, through
 * the entry's primary member; polled every minute while mounted. `all` is the
 * full ranked list; `top` is the first few of each project (`PER_PROJECT`), in
 * sidebar order.
 */
export function useUpNextIssues(): {
  all: UpNextRow[];
  top: UpNextRow[];
  total: number;
  /** True until every source has answered once, so callers can hold back an empty state. */
  loading: boolean;
} {
  const projects = useProjectStore((s) => s.projects);

  const entries = useMemo(() => buildTopLevelEntries(projects), [projects]);

  const { data: ghStatus } = useQuery({
    queryKey: ["home-up-next", "gh-status"],
    queryFn: () => window.electronAPI.github.checkStatus(),
    staleTime: Infinity,
    retry: false,
  });
  const ghReady = ghStatus?.installed === true && ghStatus.authenticated === true;

  const anyLinear = projects.some((p) => p.linearAssociations.length > 0);
  const { data: linearConnected } = useQuery({
    queryKey: ["home-up-next", "linear-connected"],
    queryFn: () => window.electronAPI.linear.isConnected(),
    staleTime: POLL_MS,
    retry: false,
    enabled: anyLinear,
  });

  const sources = useMemo(() => {
    const out: Source[] = [];
    for (const entry of entries) {
      const member = primaryMember(entry);
      if (!member) continue;
      if (ghReady) {
        out.push({ key: `gh:${member.hostId}:${member.path}`, kind: "gh", entryKey: entry.key, member });
      }
      if (linearConnected && member.linearAssociations.length > 0) {
        out.push({ key: `linear:${member.id}`, kind: "linear", entryKey: entry.key, member });
      }
    }
    return out;
  }, [entries, ghReady, linearConnected]);

  const candidates = useQueries({
    // Module-level, so the flattened list only changes when a query does.
    combine: flattenResults,
    queries: sources.map((source) =>
      source.kind === "gh"
        ? {
            queryKey: ["home-up-next", "gh", source.member.hostId, source.member.path],
            queryFn: () =>
              swallow(source.key, () =>
                window.electronAPI.github.getMyIssues(ghRepoOf(source.member), 10, "open"),
              ).then((issues) => issues.map((i) => upNextFromGitHub(i, source.entryKey))),
            staleTime: POLL_MS,
            refetchInterval: POLL_MS,
            retry: false,
          }
        : {
            queryKey: [
              "home-up-next",
              "linear",
              source.member.id,
              source.member.linearAssociations.map((a) => a.teamId).join(","),
            ],
            queryFn: () =>
              swallow(source.key, () =>
                window.electronAPI.linear.getMyIssues(
                  source.member.linearAssociations.map((a) => a.teamId),
                  { stateTypes: ["unstarted", "backlog"], limit: 10 },
                ),
              ).then((issues) => issues.map((i) => upNextFromLinear(i, source.entryKey))),
            staleTime: POLL_MS,
            refetchInterval: POLL_MS,
            retry: false,
          },
    ),
  });

  return useMemo(() => {
    const context = new Map<string, Omit<UpNextRow, "issue">>();
    for (const entry of entries) {
      const member = primaryMember(entry);
      if (!member) continue;
      context.set(entry.key, {
        project: member,
        entryName: entry.kind === "project" ? entry.project.name : entry.group.name,
        color: member.color,
      });
    }
    const ranked = upNextList(candidates.issues, projects, topLevelKeys(entries));
    const rows: UpNextRow[] = [];
    for (const issue of ranked) {
      const ctx = context.get(issue.projectKey);
      if (ctx) rows.push({ issue, ...ctx });
    }
    const rowOf = new Map(rows.map((r) => [r.issue, r]));
    const top = topUpNextPerProject(
      rows.map((r) => r.issue),
      topLevelKeys(entries),
      PER_PROJECT,
    ).map((issue) => rowOf.get(issue)!);
    return { all: rows, top, total: rows.length, loading: candidates.loading };
  }, [candidates, projects, entries]);
}
