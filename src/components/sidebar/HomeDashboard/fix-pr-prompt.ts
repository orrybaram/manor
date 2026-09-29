import type { NeedsYouCardContext } from "../../../lib/home-dashboard-studio";
import type { PrInfo } from "../../../lib/pr-info";

type PrRef = Pick<PrInfo, "number" | "title" | "url">;

/** Contexts a "Fix with agent" launch can take on: every blocked PR. */
export type FixableContext = Extract<
  NeedsYouCardContext,
  { kind: "checks" | "conflicts" | "changes-requested" | "threads" }
>;

export function isFixable(context: NeedsYouCardContext): context is FixableContext {
  return (
    context.kind === "checks" ||
    context.kind === "conflicts" ||
    context.kind === "changes-requested" ||
    context.kind === "threads"
  );
}

function prLine(pr: PrRef): string {
  return `PR #${pr.number} "${pr.title}" (${pr.url})`;
}

/**
 * The first message for a "Fix with agent" launch from a blocked-PR card
 * (ADR-198 §4): what's blocking the PR and what done looks like.
 */
export function fixPrPrompt(pr: PrRef, context: FixableContext): string {
  switch (context.kind) {
    case "checks":
      return fixChecksPrompt(pr, context.failing, context.failingCount);
    case "conflicts":
      return [
        `${prLine(pr)} has merge conflicts with its base branch.`,
        "Fetch the base branch and merge it into this branch (don't rebase or force-push). Resolve each conflict keeping the intent of both sides, run the tests, then commit the merge and push to the PR branch.",
      ].join("\n");
    case "changes-requested":
      return [
        `A reviewer requested changes on ${prLine(pr)}.`,
        `Read the reviews and review comments (\`gh pr view ${pr.number} --comments\`, and the inline threads via \`gh api\`). Address each requested change, run the tests, then commit and push to the PR branch. Finish with a short summary of what you changed for each comment.`,
      ].join("\n");
    case "threads":
      return [
        `${prLine(pr)} has ${context.count} unresolved review thread${context.count === 1 ? "" : "s"}.`,
        "Read the unresolved inline review threads (via `gh api graphql`, `reviewThreads` with `isResolved: false`). Address each one, run the tests, then commit and push to the PR branch. Don't resolve or reply to threads on GitHub; finish with a short summary of what you did for each thread.",
      ].join("\n");
  }
}

/**
 * The checks-failing prompt. It names every failing check the card knows
 * about, with run URLs so the agent can read the logs, and says what done
 * looks like: reproduce locally, fix, push. `failingCount` can exceed the
 * named runs (GitHub doesn't always return every run), so the gap is spelled
 * out.
 */
export function fixChecksPrompt(
  pr: PrRef,
  failing: readonly { name: string; url: string | null }[],
  failingCount: number,
): string {
  const lines = [`CI checks are failing on ${prLine(pr)}.`];
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
