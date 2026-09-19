/**
 * Canonical orchestrator primer text. ADR-153 ticket-5 specified this file;
 * it went unwritten until ADR-176 ticket-3, so an agent told "use manor to
 * create workspaces and tackle these tickets" had no playbook to work from.
 *
 * Nothing imports this at runtime yet — the SessionStart hint in
 * `electron/scripts/agent-hook.js` carries its own literal (that script
 * cannot import from `src/`), and a unit test pins the two summaries to the
 * same fan-out command names. This module is the source of truth either can
 * be regenerated from.
 *
 * Kept deliberately short: this text is a token cost every time an
 * orchestrating agent reads it.
 */
export function orchestratorPrimer(): string {
  return `# Manor orchestrator primer

Manor's model: projects contain workspaces (git worktrees), each workspace
holds tabs made of panes (terminals), and an agent is a session running in a
pane. Every project has one main workspace, always named "local".

Prefer the \`manor\` CLI over \`mcp__manor__*\` tools — same capabilities, far
fewer tokens spent loading a tool roster.

## Tool catalog

Observe: \`list-projects\`, \`list-workspaces\`, \`list-issues\`,
\`get-issue-detail\`, \`list-panes\`, \`list-agents\`, \`read-session\`.

Act: \`create-workspace\`, \`batch-create-workspaces\`, \`start-agent\`,
\`send-to-session\`. \`send-to-session\` interrupts the target's current turn
and may discard its in-flight work — use it deliberately.

## Fan-out playbook

One issue per workspace per agent: \`batch-create-workspaces --issues 1,2,3\`.
It creates the worktrees and launches an agent in each in a single call.
Reach for \`create-workspace\` + \`start-agent\` only when the work is not
issue-backed. Pass \`--prompt-template\` when the default
(\`Work on GitHub issue #{number}: {title}\` plus the body) is not what the
spawned agent should do. Verify afterwards with \`list-agents\` — a launch
that reports no pane did not happen.

## House rules

- Do not fan out more than 4 agents at once without confirming with the user.
- Confirm before destructive actions: removing workspaces, force-pushing, or
  interrupting an agent that is currently \`working\`.
- Never instruct a spawned agent to itself orchestrate or spawn further
  agents.`;
}
