/**
 * The **Inbox** types: what GitHub's and Linear's own notification inboxes can
 * put in Manor's bell, and the preference that switches each one. Shared by
 * the renderer and main, so this file imports nothing.
 */

export type InboxSourceId = "github" | "linear";

export type InboxKind =
  | "github-review-requested"
  | "github-mentioned"
  | "github-assigned"
  | "github-team-mentioned"
  | "github-security-alert"
  | "linear-assigned"
  | "linear-mentioned"
  | "linear-comment"
  | "linear-status-changed"
  | "linear-triage"
  | "linear-review"
  | "linear-reaction";

export type InboxPreferenceKey =
  | "notifyOnGithubReviewRequested"
  | "notifyOnGithubMentioned"
  | "notifyOnGithubAssigned"
  | "notifyOnGithubTeamMentioned"
  | "notifyOnGithubSecurityAlert"
  | "notifyOnLinearAssigned"
  | "notifyOnLinearMentioned"
  | "notifyOnLinearComments"
  | "notifyOnLinearStatusChanges"
  | "notifyOnLinearTriage"
  | "notifyOnLinearReviews"
  | "notifyOnLinearReactions";

export interface InboxType {
  kind: InboxKind;
  source: InboxSourceId;
  /** GitHub's `reason`, or Linear's `category`. */
  upstream: string;
  preference: InboxPreferenceKey;
  /** The Settings row. */
  label: string;
  /** On by default, which also keeps it out of the card's "More types". */
  defaultOn: boolean;
}

export const INBOX_TYPES: readonly InboxType[] = [
  { kind: "github-review-requested", source: "github", upstream: "review_requested", preference: "notifyOnGithubReviewRequested", label: "Review requested", defaultOn: true },
  { kind: "github-mentioned", source: "github", upstream: "mention", preference: "notifyOnGithubMentioned", label: "Mentioned", defaultOn: true },
  { kind: "github-assigned", source: "github", upstream: "assign", preference: "notifyOnGithubAssigned", label: "Assigned", defaultOn: true },
  { kind: "github-team-mentioned", source: "github", upstream: "team_mention", preference: "notifyOnGithubTeamMentioned", label: "Team mentioned", defaultOn: false },
  { kind: "github-security-alert", source: "github", upstream: "security_alert", preference: "notifyOnGithubSecurityAlert", label: "Security alert", defaultOn: false },
  { kind: "linear-assigned", source: "linear", upstream: "assignments", preference: "notifyOnLinearAssigned", label: "Assigned", defaultOn: true },
  { kind: "linear-mentioned", source: "linear", upstream: "mentions", preference: "notifyOnLinearMentioned", label: "Mentioned", defaultOn: true },
  { kind: "linear-comment", source: "linear", upstream: "commentsAndReplies", preference: "notifyOnLinearComments", label: "Comments and replies", defaultOn: false },
  { kind: "linear-status-changed", source: "linear", upstream: "statusChanges", preference: "notifyOnLinearStatusChanges", label: "Status changes", defaultOn: false },
  { kind: "linear-triage", source: "linear", upstream: "triage", preference: "notifyOnLinearTriage", label: "Triage", defaultOn: false },
  { kind: "linear-review", source: "linear", upstream: "reviews", preference: "notifyOnLinearReviews", label: "Reviews", defaultOn: false },
  { kind: "linear-reaction", source: "linear", upstream: "reactions", preference: "notifyOnLinearReactions", label: "Reactions", defaultOn: false },
];

/** How one source stands, for its Settings card. */
export type InboxSourceStatus =
  /** Waiting on its first check. */
  | { state: "starting" }
  /** Not signed in: `gh` missing or logged out, or no Linear key. */
  | { state: "signed-out" }
  /** The last check failed; it keeps trying, more slowly. */
  | { state: "error"; message: string; checkedAt: string | null }
  /** Working. `covered` is the repos or teams linked to projects. */
  | { state: "ok"; account: string | null; covered: number; checkedAt: string };

export type InboxStatus = Record<InboxSourceId, InboxSourceStatus>;
