/**
 * `POST /files/open`: show a file in the file viewer, from the `manor` CLI.
 *
 * A server route, because a workspace's layout is its server's: the CLI on a
 * remote host asks that host's server, which adds the tab with no window
 * involved, and any connected desktop follows. `layout.showFile` then brings
 * the pane forward wherever that workspace is on screen.
 *
 * The file is read first, so a path the viewer would refuse is the CLI's
 * error and not a tab that holds only that error.
 */

import { isHomePath } from "../../src/lib/home";
import { filePathFor, fileRoot, pathInFileRoot } from "../../src/lib/file-location";
import { fileMedia } from "../../src/lib/file-media";
import { allPaneIds, type PaneNode } from "../../src/lib/layout/pane-tree";
import { createFileTab } from "../../src/lib/layout/tab-builders";
import type { WorkspaceLayout } from "../../src/lib/layout/workspace-layout";
import {
  LOCAL_HOST_ID,
  normalizeHostId,
  parseWorkspaceKey,
  workspaceKey,
} from "../../src/lib/workspace-key";
import { checkWorkspaceFileBytes, readWorkspaceFile } from "../workspace-files";
import { forwardToHost, onAdoptedHost } from "./host-forward";
import { optionalBoolean, optionalString, requireString } from "./pane-validators";
import { ROUTE_ORIGIN } from "./structural-route";
import type { ServerRoute } from "./types";
import { withWorkspaceHost } from "./workspace-host";

function optionalPositive(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Argument ${key} must be a positive whole number`);
  }
  return value;
}

function paneWithFile(node: PaneNode, filePath: string): string | null {
  if (node.type === "leaf") {
    return node.contentType === "file" && node.filePath === filePath ? node.paneId : null;
  }
  return paneWithFile(node.first, filePath) ?? paneWithFile(node.second, filePath);
}

/** The pane and tab already showing `filePath`, so a second open isn't a second editor. */
function findOpen(layout: WorkspaceLayout, filePath: string) {
  for (const panel of Object.values(layout.panels)) {
    for (const tab of panel.tabs) {
      const paneId = paneWithFile(tab.rootNode, filePath);
      if (paneId) return { paneId, tabId: tab.id };
    }
  }
  return null;
}

export const fileRoutes: ServerRoute[] = [
  {
    method: "POST",
    path: "/files/open",
    async handler({ deps, json, readBody }) {
      const body = withWorkspaceHost(deps, await readBody());
      let absolute: string;
      let line: number | undefined;
      let col: number | undefined;
      let background: boolean | undefined;
      let named: string | undefined;
      try {
        absolute = requireString(body, "path");
        if (!absolute.startsWith("/")) throw new Error("Argument path must be absolute");
        line = optionalPositive(body, "line");
        col = optionalPositive(body, "col");
        background = optionalBoolean(body, "background");
        named = optionalString(body, "workspacePath");
      } catch (err) {
        json(400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }

      const namedHost = typeof body.hostId === "string" && body.hostId ? body.hostId : LOCAL_HOST_ID;
      if (named && onAdoptedHost(deps, namedHost)) {
        const { hostId: _hostId, ...forward } = body;
        await forwardToHost(deps, json, namedHost, "POST", "/files/open", forward);
        return;
      }

      const store = deps.layoutStore;
      const last = store.getLastActiveWorkspacePath();
      // No workspace named: the last active one, if it is on this machine. The
      // path is this machine's, and it would name nothing on another host.
      const key = named
        ? workspaceKey(namedHost, named)
        : last && normalizeHostId(parseWorkspaceKey(last).hostId) === LOCAL_HOST_ID
          ? last
          : null;
      if (!key) {
        json(400, { error: "No workspace to open it in: pass workspacePath, or open a workspace first" });
        return;
      }
      const { hostId, path: workspacePath } = parseWorkspaceKey(key);
      if (isHomePath(workspacePath)) {
        json(400, { error: "The Dashboard can't host panes" });
        return;
      }

      const filePath = filePathFor(workspacePath, absolute);
      const check = fileMedia(filePath) ? checkWorkspaceFileBytes : readWorkspaceFile;
      const read = await check(
        deps.backendRegistry.get(normalizeHostId(hostId)),
        fileRoot({ path: workspacePath }, filePath).path,
        pathInFileRoot(filePath),
      ).catch((err: unknown) => ({
        ok: false as const,
        message: err instanceof Error ? err.message : String(err),
      }));
      if (!read.ok) {
        json(400, { error: read.message });
        return;
      }

      const entry = store.get(key);
      let shown = entry && findOpen(entry.layout, filePath);
      if (!shown) {
        const tab = createFileTab(filePath);
        const result = await store.apply(
          key,
          {
            type: "new-tab",
            tab,
            panelId: store.primaryViewport(key)?.activePanelId ?? undefined,
            select: false,
          },
          ROUTE_ORIGIN,
        );
        if ("error" in result) {
          json(400, { error: result.error });
          return;
        }
        shown = { paneId: allPaneIds(tab.rootNode)[0], tabId: tab.id };
      }
      if (!background) {
        deps.showFile({
          paneId: shown.paneId,
          path: filePath,
          ...(line !== undefined && { line }),
          ...(col !== undefined && { col }),
        });
      }
      json(200, { ...shown, path: filePath });
    },
  },
];
