import { createPendingRequests } from "./pending-line";

/**
 * A review comment a file pane should scroll to and light once its file is
 * open: the review list's "jump to comment". Taken once, like a terminal
 * link's line (`pendingLines`); the asker opens the file's diff.
 */
export const pendingComments = createPendingRequests<{
  /** Workspace-relative path the comment is on. */
  path: string;
  commentId: string;
}>();
