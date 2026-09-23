/**
 * The methods a paired device may not call, however `full` its tier
 * (ADR-180 D4).
 *
 * The tables in `./handlers/` flag each of these `localOnly`, and that flag is
 * what dispatch reads. This list is the same fact for the browser, which may
 * not import the tables: `src/bridge/unavailable.ts` reads it to answer every
 * one of them without a round trip or leave it to the host's refusal on
 * purpose. `surface.ts` fails the build if the flags and this list disagree,
 * or if a method here has no browser answer. Which is why this file imports
 * nothing: it is read from the main process and from a browser bundle, the
 * same as `./types.ts`.
 *
 * Two reasons put a method here. Most name a resource only the machine has —
 * a prewarmed session, the desk's viewport file, a window. The last six are a
 * key, or the lock it turns, and they are the only entries whose absence would
 * be a security bug rather than a wrong answer.
 */
export const LOCAL_ONLY_METHODS = [
  "pty.consumePrewarmed",
  "pty.updatePrewarmCwd",
  "viewport.load",
  "viewport.save",
  "appCommands.result",
  "keybindings.set",
  "keybindings.reset",
  "keybindings.resetAll",
  "keybindings.runInMainWindow",
  "remoteControl.setEnabled",
  "remoteControl.pair",
  "remoteControl.revoke",
  "remoteControl.startTunnel",
  "remoteControl.stopTunnel",
  "linear.connect",
] as const;

export type LocalOnlyMethod = (typeof LOCAL_ONLY_METHODS)[number];
