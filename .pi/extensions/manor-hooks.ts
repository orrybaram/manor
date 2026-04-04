/**
 * Manor hooks extension for pi — sends agent lifecycle events to Manor.
 *
 * This extension notifies Manor of pi's agent state changes so it can
 * display real-time status (thinking, working, complete) in the UI.
 *
 * Events mapped:
 * - session_start → SessionStart (detected as "thinking")
 * - session_shutdown → SessionEnd (detected as "idle")
 * - agent_start → UserPromptSubmit (detected as "thinking")
 * - agent_end → Stop (detected as "responded")
 * - tool_execution_start → PreToolUse (detected as "working")
 * - tool_execution_end → PostToolUse/PostToolUseFailure (detected as "thinking")
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync } from "node:fs";

const HOOK_PORT_FILE = (process.env.HOME || "/tmp") + "/.manor/hook-port";

async function sendHook(eventType: string): Promise<void> {
  const paneId = process.env.MANOR_PANE_ID;
  if (!paneId) return;

  let port: string | undefined;
  try {
    port = readFileSync(HOOK_PORT_FILE, "utf-8").trim();
  } catch {
    port = process.env.MANOR_HOOK_PORT;
  }
  if (!port) return;

  const url = new URL("http://127.0.0.1/hook/event");
  url.port = port;
  url.searchParams.set("paneId", paneId);
  url.searchParams.set("eventType", eventType);
  url.searchParams.set("kind", "pi");

  try {
    await fetch(url.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Ignore errors — Manor might not be running
  }
}

export default function (pi: ExtensionAPI) {
  // Session lifecycle
  pi.on("session_start", async () => {
    await sendHook("SessionStart");
  });

  pi.on("session_shutdown", async () => {
    await sendHook("SessionEnd");
  });

  // Agent lifecycle
  pi.on("agent_start", async () => {
    await sendHook("UserPromptSubmit");
  });

  pi.on("agent_end", async () => {
    await sendHook("Stop");
  });

  // Tool execution
  pi.on("tool_execution_start", async () => {
    await sendHook("PreToolUse");
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.isError) {
      await sendHook("PostToolUseFailure");
    } else {
      await sendHook("PostToolUse");
    }
  });
}
