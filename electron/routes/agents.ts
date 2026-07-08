/** `POST /agents` — launch an agent pane in a workspace. */

import { startAgent } from "./renderer-bridge";
import type { Route } from "./types";

export const agentRoutes: Route[] = [
  {
    method: "POST",
    path: "/agents",
    async handler({ json, readBody }) {
      const body = await readBody();
      const workspacePath = body.workspacePath;
      if (typeof workspacePath !== "string") {
        json(400, { error: "Missing 'workspacePath' string in request body" });
        return;
      }
      const prompt = typeof body.prompt === "string" ? body.prompt : undefined;
      const result = startAgent(workspacePath, prompt);
      json(result.ok ? 200 : 503, result);
    },
  },
];
