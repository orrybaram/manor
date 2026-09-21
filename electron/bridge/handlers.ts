/**
 * What `ns.method` means on the bridge (ADR-178 D8, ADR-180 D1, ADR-182 D3).
 *
 * **One table, two transports, every caller.** A paired `full` device over
 * the WebSocket and every Electron renderer window over `bridge:*` IPC reach
 * the same entry, with the same validation. Each namespace is written in
 * `./handlers/<ns>.ts` as a table of `method(fn, rules)`, and this file only
 * joins them and reads the rules back out. Nothing reaches into `ipcMain`: a
 * method that is not on a table and not in the preload does not exist, and a
 * frame naming one is answered `unavailable:web`.
 *
 * Every handler is `(ctx, ...wireArgs)`. `ctx.caller` is the connection the
 * frame arrived on — its id and its caller class — so a handler that needs to
 * know who is asking (a pane's viewers, a layout command's origin, a progress
 * stream's addressee) reads it there, and a frame can never claim to be
 * somebody else.
 *
 * Adding a *write* is a security decision, not a convenience one. Since
 * ADR-182 D2 this table, not the HTTP route table, is the whole of what a
 * `full` device reaches beyond `send` — so every method added is new power,
 * and one a stolen token can use without an audit line unless it is
 * `mutating`.
 *
 * **What keeps this honest is a compile error.** `./surface.ts` checks every
 * key here against `ElectronAPI`, and checks the rules against each other and
 * against `./local-only.ts`.
 */

import { flatten, type Method, type MethodRules } from "./method";
import { agents } from "./handlers/agents";
import { appCommands } from "./handlers/app-commands";
import { branches, diffs, git, gitPush } from "./handlers/branches-diffs";
import { github, linear } from "./handlers/integrations";
import { layout } from "./handlers/layout";
import { notifications } from "./handlers/notifications";
import { ports } from "./handlers/ports";
import { keybindings, preferences } from "./handlers/preferences";
import { processes } from "./handlers/processes";
import { projects } from "./handlers/projects";
import { pty } from "./handlers/pty";
import { remoteControl } from "./handlers/remote-control";
import { stats } from "./handlers/stats";
import { theme } from "./handlers/theme";
import { viewport } from "./handlers/viewport";

export type { BridgeHandler } from "./method";

const METHODS = flatten({
  pty,
  layout,
  viewport,
  projects,
  theme,
  preferences,
  keybindings,
  remoteControl,
  agents,
  notifications,
  stats,
  ports,
  processes,
  branches,
  diffs,
  git,
  "git.push": gitPush,
  github,
  linear,
  appCommands,
});

type Methods = typeof METHODS;

/**
 * One key of the table — the vocabulary of everything that describes it.
 * `surface.ts` checks this against `ElectronAPI`.
 */
export type HandlerMethod = keyof Methods;

/** `ns.method` → handler, the table dispatch calls into. */
export const HANDLERS = Object.fromEntries(
  Object.entries(METHODS).map(([key, entry]) => [key, (entry as Method).fn]),
) as { [K in HandlerMethod]: Methods[K]["fn"] };

/** The methods whose table entry carries `rule`. */
type WithRule<Rule extends keyof MethodRules> = {
  [K in HandlerMethod]: Methods[K]["rules"] extends Record<Rule, true>
    ? K
    : never;
}[HandlerMethod];

function withRule(rule: keyof MethodRules): ReadonlySet<string> {
  return new Set(
    Object.entries(METHODS)
      .filter(([, entry]) => (entry as Method).rules[rule])
      .map(([key]) => key),
  );
}

/** Which invokes leave an audit line when a device makes them. */
export const MUTATING = withRule("mutating");
export type MutatingMethod = WithRule<"mutating">;

/** Which invokes carry a credential as their first argument. */
export const SECRET_FIRST_ARG = withRule("secretFirstArg");
export type SecretFirstArgMethod = WithRule<"secretFirstArg">;

/** Which invokes a device is refused, however `full` its tier. */
export const LOCAL_ONLY = withRule("localOnly");
export type TableLocalOnlyMethod = WithRule<"localOnly">;
