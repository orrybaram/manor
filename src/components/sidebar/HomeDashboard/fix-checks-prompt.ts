import type { PrInfo } from "../../../lib/pr-info";

/**
 * The first message for a "Fix with agent" launch from a checks-failing card
 * (ADR-198 §4). It names the PR and every failing check the card knows about,
 * with run URLs so the agent can read the logs, and says what done looks
 * like: reproduce locally, fix, push. `failingCount` can exceed the named
 * runs (GitHub doesn't always return every run), so the gap is spelled out.
 */
export function fixChecksPrompt(
  pr: Pick<PrInfo, "number" | "title" | "url">,
  failing: readonly { name: string; url: string | null }[],
  failingCount: number,
): string {
  const lines = [
    `CI checks are failing on PR #${pr.number} "${pr.title}" (${pr.url}).`,
  ];
  if (failing.length > 0) {
    const runs = failing.map((run) => (run.url ? `${run.name} (${run.url})` : run.name));
    lines.push(`Failing checks: ${runs.join(", ")}.`);
  }
  const unnamed = failingCount - failing.length;
  if (unnamed > 0) {
    lines.push(
      `${unnamed} more failing check${unnamed === 1 ? "" : "s"} ${unnamed === 1 ? "is" : "are"} listed on the PR.`,
    );
  }
  lines.push(
    "Read the check logs, reproduce each failure locally, fix it, run the checks again to confirm, then commit and push to the PR branch.",
  );
  return lines.join("\n");
}
