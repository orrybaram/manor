/**
 * Claude Code's built-in slash commands (ADR-217 D4), for the phone's `/` menu.
 *
 * Claude Code doesn't publish its command list and the transcript's skill
 * listing doesn't include built-ins, so this is hard-coded. It is a
 * convenience list: a command missing from it can still be typed.
 *
 * Starting set from the ADR. Installed Claude Code was v2.1.296, but the list
 * could not be confirmed against `/help` without launching an interactive
 * session, so nothing was dropped. Check it against `/help` now and then.
 *
 * No imports: the renderer imports `isInteractiveCommand` from here.
 */

export type ChatCommand = {
  /** "review", "anthropic-skills:pdf", "clear" — without the slash. */
  name: string;
  description: string;
  source: "builtin" | "skill";
  /** Opens a menu in the TUI that the chat can't show. */
  interactive?: boolean;
};

export const BUILTIN_COMMANDS: readonly ChatCommand[] = [
  { name: "clear", description: "Clear the conversation and start fresh", source: "builtin" },
  { name: "compact", description: "Summarize the conversation to free up context", source: "builtin" },
  { name: "cost", description: "Show token usage and cost for this session", source: "builtin" },
  { name: "context", description: "Show how much of the context window is used", source: "builtin" },
  { name: "export", description: "Export the conversation to a file or the clipboard", source: "builtin" },
  { name: "pr-comments", description: "Fetch comments from the current pull request", source: "builtin" },
  { name: "release-notes", description: "Show the Claude Code release notes", source: "builtin" },
  { name: "review", description: "Review a pull request", source: "builtin" },
  { name: "security-review", description: "Review pending changes for security issues", source: "builtin" },
  { name: "todos", description: "List the current todo items", source: "builtin" },
  { name: "model", description: "Choose the model", source: "builtin", interactive: true },
  { name: "config", description: "Open the settings", source: "builtin", interactive: true },
  { name: "resume", description: "Resume a previous conversation", source: "builtin", interactive: true },
  { name: "mcp", description: "Manage MCP servers", source: "builtin", interactive: true },
  { name: "agents", description: "Manage subagents", source: "builtin", interactive: true },
  { name: "permissions", description: "Manage tool permissions", source: "builtin", interactive: true },
  { name: "hooks", description: "Manage hooks", source: "builtin", interactive: true },
  { name: "memory", description: "Edit memory files", source: "builtin", interactive: true },
  { name: "login", description: "Sign in to your account", source: "builtin", interactive: true },
  { name: "logout", description: "Sign out of your account", source: "builtin", interactive: true },
  { name: "doctor", description: "Check the health of the installation", source: "builtin", interactive: true },
  { name: "status", description: "Show version, model and account status", source: "builtin", interactive: true },
  { name: "plugin", description: "Manage plugins", source: "builtin", interactive: true },
  { name: "theme", description: "Change the color theme", source: "builtin", interactive: true },
  { name: "help", description: "Show help and the available commands", source: "builtin", interactive: true },
  { name: "add-dir", description: "Add a working directory", source: "builtin", interactive: true },
  { name: "ide", description: "Manage the IDE integration", source: "builtin", interactive: true },
  { name: "bashes", description: "Manage background shell tasks", source: "builtin", interactive: true },
];

const INTERACTIVE = new Set(
  BUILTIN_COMMANDS.filter((c) => c.interactive).map((c) => c.name),
);

/** Whether `/name` opens a menu that only the terminal can show. */
export function isInteractiveCommand(name: string): boolean {
  return INTERACTIVE.has(name);
}
