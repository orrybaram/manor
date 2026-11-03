import type { NeedsYouCardContext } from "../../../lib/home-dashboard-studio";
import type { PrInfo } from "../../../lib/pr-info";
import { renderPrompt, type PromptOverrides } from "../../../lib/prompts/catalog";

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
 * The first message for a "Fix with agent" launch from a blocked-PR card.
 * Failing checks and review threads are the PR card's briefs (`fetchBrief`),
 * with the logs and thread text it reads fresh from GitHub; the other two say
 * what's blocking the PR and what done looks like. Rejects when a brief can't
 * be fetched, or the PR no longer has anything for it.
 */
export async function fixPrPrompt(
  pr: PrRef,
  context: FixableContext,
  fetchBrief: (task: "checks" | "comments") => Promise<string>,
  overrides?: PromptOverrides | null,
): Promise<string> {
  switch (context.kind) {
    case "checks":
      return fetchBrief("checks");
    case "threads":
      return fetchBrief("comments");
    case "conflicts":
      return renderPrompt("prConflicts", { pr: prLine(pr) }, overrides);
    case "changes-requested":
      return renderPrompt("prChanges", { pr: prLine(pr), number: String(pr.number) }, overrides);
  }
}
