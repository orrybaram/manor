/** Where the phone new-agent composer will start its agent (ADR-222). */
export type NewAgentTarget = {
  projectId: string;
  workspacePath: string;
  newWorktree: boolean;
};
