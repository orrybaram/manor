/**
 * The shared list of `ToolModule`s that both the MCP entry
 * (`mcp-webview-server.ts`) and the `manor` CLI compose their surface from.
 * Order matters for `manor --help` grouping — do not reorder.
 */

import { webviewModule } from "./tools-webview";
import { projectsModule } from "./tools-projects";
import { agentsModule } from "./tools-agents";
import { panesModule } from "./tools-panes";
import { sessionsModule } from "./tools-sessions";
import { gitModule } from "./tools-git";

export const modules = [
  webviewModule,
  projectsModule,
  agentsModule,
  panesModule,
  sessionsModule,
  gitModule,
];

export const moduleLabels = [
  "webview",
  "projects",
  "agents",
  "panes",
  "sessions",
  "git",
] as const;
