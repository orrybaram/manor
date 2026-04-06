import type { IpcDeps } from "./types";
import * as ptyIpc from "./pty";
import * as layoutIpc from "./layout";
import * as projectsIpc from "./projects";
import * as themeIpc from "./theme";
import * as portsIpc from "./ports";
import * as branchesDiffsIpc from "./branches-diffs";
import * as integrationsIpc from "./integrations";
import * as webviewIpc from "./webview";
import * as tasksIpc from "./tasks";
import * as miscIpc from "./misc";
import * as processesIpc from "./processes";

export { createWebviewServer } from "./webview";

export function registerAllIpc(deps: IpcDeps): void {
  ptyIpc.register(deps);
  layoutIpc.register(deps);
  projectsIpc.register(deps);
  themeIpc.register(deps);
  portsIpc.register(deps);
  branchesDiffsIpc.register(deps);
  integrationsIpc.register(deps);
  webviewIpc.register(deps);
  tasksIpc.register(deps);
  miscIpc.register(deps);
  processesIpc.register(deps);
}
