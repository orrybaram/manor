/**
 * Claude Code's built-in slash commands, for the phone's `/` menu.
 *
 * Claude Code doesn't publish its command list and the transcript's skill
 * listing doesn't include built-ins, so this is hard-coded. It is a
 * convenience list: a command missing from it can still be typed.
 *
 * Starting set written by hand, then checked against Claude Code
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
  /** Opens a menu in the TUI that the chat can't show: "always", or
   *  "bare-only" when an argument acts at once instead (`/model sonnet`). */
  menu?: "always" | "bare-only";
  /** Fixed arguments the phone can offer as a native picker. */
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
    menu: "bare-only",
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
    menu: "bare-only",
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
    menu: "bare-only",
    choices: [
      { value: "on", label: "On", description: "Faster output" },
      { value: "off", label: "Off", description: "Standard speed" },
    ],
  },
  { name: "config", description: "Open the settings", source: "builtin", menu: "bare-only" },
  { name: "resume", description: "Resume a previous conversation", source: "builtin", menu: "bare-only" },
  { name: "mcp", description: "Manage MCP servers", source: "builtin", menu: "bare-only" },
  { name: "permissions", description: "Manage tool permissions", source: "builtin", menu: "always" },
  { name: "hooks", description: "Manage hooks", source: "builtin", menu: "always" },
  { name: "memory", description: "Edit memory files", source: "builtin", menu: "always" },
  { name: "login", description: "Sign in to your account", source: "builtin", menu: "always" },
  { name: "logout", description: "Sign out of your account", source: "builtin", menu: "always" },
  { name: "doctor", description: "Check the health of the installation", source: "builtin", menu: "always" },
  { name: "status", description: "Show version, model and account status", source: "builtin", menu: "always" },
  { name: "plugin", description: "Manage plugins", source: "builtin", menu: "always" },
  { name: "theme", description: "Change the color theme", source: "builtin", menu: "always" },
  { name: "help", description: "Show help and the available commands", source: "builtin", menu: "always" },
  { name: "add-dir", description: "Add a working directory", source: "builtin", menu: "bare-only" },
  { name: "ide", description: "Manage the IDE integration", source: "builtin", menu: "always" },
  { name: "bashes", description: "Manage background shell tasks", source: "builtin", menu: "always" },
];

const BY_NAME = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));

/** The built-in entry for `/name`, if any. */
export function findBuiltin(name: string): ChatCommand | undefined {
  return BY_NAME.get(name);
}

/**
 * Whether sending `entry` with `args` opens a TUI menu. The caller
 * passes the fetched entry (a skill of the same name replaces a built-in), else
 * the built-in. With an argument, a "bare-only" command acts at once instead.
 */
export function opensMenu(entry: ChatCommand | undefined, args: string): boolean {
  if (!entry) return false;
  return entry.menu === "always" || (entry.menu === "bare-only" && args.trim() === "");
}
