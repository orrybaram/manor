/**
 * ADR-202 §2: an in-memory tracker for tests. Lists the rows it was given,
 * matches links by URL, and never touches `window.electronAPI`.
 */

import type { TaskProvider, TaskRow } from "../tasks";
import { sameUrl } from "./shared";
import type { TaskTracker } from "./types";

/** A `provider` tracker whose every list query returns `rows` (those of `provider`). */
export function memoryTracker(
  provider: TaskProvider,
  rows: readonly TaskRow[],
): TaskTracker {
  const own = rows.filter((row) => row.provider === provider);
  return {
    provider,
    label: provider,
    statusQuery: () => ({
      queryKey: ["memory", provider, "status"],
      queryFn: async () => true,
      staleTime: Infinity,
    }),
    canList: () => true,
    listQuery: (ctx, scope) => ({
      queryKey: ["memory", provider, "list", scope, ctx.entryKey],
      queryFn: async () =>
        own.filter((row) => row.projectEntryKey === ctx.entryKey),
      staleTime: Infinity,
    }),
    refOf: (row) => ({
      provider,
      project: row.project,
      id: row.key,
      displayId: row.displayId,
      title: row.title,
      url: row.url,
    }),
    refFromLink: (link, project) => ({
      provider,
      project,
      id: link.id,
      displayId: link.identifier,
      title: link.title,
      url: link.url,
    }),
    detailQuery: (ref) => ({
      queryKey: ["memory", provider, "detail", ref.id],
      queryFn: async () => ({
        body: null,
        status: { label: "Open", tone: "open" },
        assignees: [],
        labels: [],
        images: [],
      }),
      staleTime: Infinity,
    }),
    startWork: () => {},
    ownsLink: (link) => link.id.startsWith("gh-") === (provider === "github"),
    matchesLink: (link, row) =>
      row.provider === provider && sameUrl(link.url, row.url),
    homeUrl: () => null,
  };
}
