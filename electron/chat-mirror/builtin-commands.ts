/**
 * Claude Code's built-in slash commands (ADR-217 D4), for the phone's `/` menu.
 *
 * Claude Code doesn't publish its command list and the transcript's skill
 * listing doesn't include built-ins, so this is hard-coded. It is a
 * convenience list: a command missing from it can still be typed.
 *
 * Starting set from the ADR, then checked (ADR-218 D1) against Claude Code
 * v2.1.296: `strings` on the binary for each command's table entry
 * (`argumentHint`, `immediate`, hidden/removed) and `claude --help` for the
 * `--model` aliases and `--effort` levels. `/agents` is removed there. Check it
 * against a newer version now and then.
 *
 * No imports: the renderer imports `opensMenu` from here.
 */

export type ChatCommand = {
  /** "review", "anthropic-skills:pdf", "clear" — without the slash. */
  name: string;
  description: string;
  source: "builtin" | "skill";
  /** Sent bare, opens a menu in the TUI that the chat can't show. */
  interactive?: boolean;
  /** With an argument it acts at once, no menu (`/model sonnet`). */
  argSkipsMenu?: boolean;
  /** Fixed arguments the phone can offer as a native picker (ADR-218 D2). */
  choices?: { value: string; label: string; description?: string }[];
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
  {
    name: "model",
    description: "Choose the model",
    source: "builtin",
    interactive: true,
    argSkipsMenu: true,
    choices: [
      { value: "default", label: "Default", description: "The recommended model for your plan" },
      { value: "fable", label: "Fable", description: "Latest Fable model" },
      { value: "opus", label: "Opus", description: "Latest Opus model" },
      { value: "sonnet", label: "Sonnet", description: "Latest Sonnet model" },
      { value: "haiku", label: "Haiku", description: "Fastest, lightest model" },
    ],
  },
  {
    name: "effort",
    description: "Set the effort level",
    source: "builtin",
    interactive: true,
    argSkipsMenu: true,
    choices: [
      { value: "low", label: "Low", description: "Quickest, least thinking" },
      { value: "medium", label: "Medium", description: "Balanced" },
      { value: "high", label: "High", description: "More thorough" },
      { value: "xhigh", label: "Extra high", description: "Very thorough" },
      { value: "max", label: "Max", description: "Deepest reasoning" },
    ],
  },
  {
    name: "fast",
    description: "Toggle fast mode",
    source: "builtin",
    interactive: true,
    argSkipsMenu: true,
    choices: [
      { value: "on", label: "On", description: "Faster output" },
      { value: "off", label: "Off", description: "Standard speed" },
    ],
  },
  { name: "config", description: "Open the settings", source: "builtin", interactive: true, argSkipsMenu: true },
  { name: "resume", description: "Resume a previous conversation", source: "builtin", interactive: true, argSkipsMenu: true },
  { name: "mcp", description: "Manage MCP servers", source: "builtin", interactive: true, argSkipsMenu: true },
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
  { name: "add-dir", description: "Add a working directory", source: "builtin", interactive: true, argSkipsMenu: true },
  { name: "ide", description: "Manage the IDE integration", source: "builtin", interactive: true },
  { name: "bashes", description: "Manage background shell tasks", source: "builtin", interactive: true },
];

const BY_NAME = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));

/** Whether `/name` opens a menu that only the terminal can show. */
export function isInteractiveCommand(name: string): boolean {
  return BY_NAME.get(name)?.interactive === true;
}

/**
 * Whether sending `/name args` opens a TUI menu (ADR-218 D1). `command` is the
 * fetched entry (a skill of the same name replaces a built-in); when it's
 * undefined the built-in entry stands in. With an argument, a command that has
 * `argSkipsMenu` acts at once instead.
 */
export function opensMenu(
  command: ChatCommand | undefined,
  name: string,
  args: string,
): boolean {
  const entry = command ?? BY_NAME.get(name);
  if (entry?.interactive !== true) return false;
  return args.trim() === "" || entry.argSkipsMenu !== true;
}
