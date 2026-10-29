/**
 * The handler table's window-free half: every method a Manor
 * server can answer wherever it runs, typed over `ServerDeps`.
 *
 * `./handlers.ts` joins this with the desktop-only methods into
 * `DESKTOP_TABLE`. Nothing here may read a window, the menu or the webview
 * server — `satisfies` below makes that a compile error — and nothing here may
 * import `electron` at runtime, which
 * `electron/platform/__tests__/electron-free.test.ts` checks by bundling this
 * file. A namespace whose module still drags Electron in, or that has a
 * method needing a window, lives (in whole or in part) in `DESKTOP_METHODS`.
 */

import type { ServerDeps } from "../ipc/types";
import { flatten, type BridgeHandler, type Method } from "./method";
import { agents } from "./handlers/agents";
import { agentActivity } from "./handlers/agent-activity";
import { automations } from "./handlers/automations";
import { appCommands } from "./handlers/app-commands";
import { branches, diffs, git, gitPush } from "./handlers/branches-diffs";
import { chat } from "./handlers/chat";
import { files } from "./handlers/files";
import { github, linear } from "./handlers/integrations";
import { jev } from "./handlers/jev";
import { hosts } from "./handlers/hosts";
import { hostProfiles } from "./handlers/host-profiles";
import { layout } from "./handlers/layout";
import { notifications } from "./handlers/notifications";
import { pasteImage } from "./handlers/paste-image";
import { ports } from "./handlers/ports";
import { keybindings, preferences } from "./handlers/preferences";
import { processes } from "./handlers/processes";
import { projects } from "./handlers/projects";
import { pty } from "./handlers/pty";
import { remoteControl } from "./handlers/remote-control";
import { sessions } from "./handlers/sessions";
import { stats } from "./handlers/stats";
import { theme } from "./handlers/theme";
import { viewport } from "./handlers/viewport";

// The few methods of a shared namespace that need a window are
// `DESKTOP_METHODS`' (`./handlers.ts`); the rest of the namespace is here.
const { runInMainWindow: _runInMainWindow, ...serverKeybindings } = keybindings;
const { list: _processesList, ...serverProcesses } = processes;

export const SERVER_METHODS = flatten({
  pty,
  chat,
  pasteImage,
  layout,
  viewport,
  projects,
  hosts,
  hostProfiles,
  theme,
  preferences,
  keybindings: serverKeybindings,
  remoteControl,
  agents,
  sessions,
  notifications,
  agentActivity,
  automations,
  stats,
  ports,
  processes: serverProcesses,
  branches,
  diffs,
  files,
  git,
  "git.push": gitPush,
  github,
  linear,
  jev,
  appCommands,
}) satisfies Readonly<Record<string, Method<BridgeHandler<ServerDeps>>>>;
