import type { PrInfo, PrMergeOptions } from "./pr-info";
import { prVerdict } from "./pr-readiness";

/** What the Merge button offers right now, or why it can't. */
type MergeOffer =
  | { kind: "merge" }
  | { kind: "queue" }
  | { kind: "auto" }
  | { kind: "none"; reason: string };

export function mergeOffer(pr: PrInfo, options: PrMergeOptions | undefined): MergeOffer {
  if (!options) return { kind: "none", reason: "Reading the repo's merge settings…" };
  if (options.allowed.length === 0) return { kind: "none", reason: "This repo allows no merge method" };
  if (pr.isDraft) return { kind: "none", reason: "A draft PR can't merge; mark it ready first" };
  const verdict = prVerdict(pr);
  if (verdict.readiness === "blocked") {
    if (verdict.blocker.kind === "conflicts") return { kind: "none", reason: "Resolve the merge conflicts first" };
    if (verdict.blocker.kind === "checks") return { kind: "none", reason: "Fix the failing checks first" };
  }
  if (options.mergeQueue) return { kind: "queue" };
  if (verdict.readiness === "pending" || verdict.readiness === "review") {
    return options.autoMergeAllowed
      ? { kind: "auto" }
      : { kind: "none", reason: "Waiting on checks or review, and this repo has no auto-merge" };
  }
  return { kind: "merge" };
}
