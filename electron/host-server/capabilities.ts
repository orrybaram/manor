/**
 * What a host server can do beyond the basics, as its `hostServer.status()`
 * reports it. A leaf, so the desktop can read a status
 * without loading the server's relay.
 */

/**
 * The capability a host server reports when it accepts desktop viewer
 * streams (`server-bridge --viewer`). A desktop opens a direct
 * bridge only to a host that says so; any other host is reached through main.
 */
export const VIEWER_BRIDGE_CAPABILITY = "viewer-bridge";

/** Every capability this build of the host server reports in its status. */
export const HOST_SERVER_CAPABILITIES: readonly string[] = [VIEWER_BRIDGE_CAPABILITY];

/**
 * Whether a status says the host takes desktop viewer streams. A status from
 * an older host server has no `capabilities`, and so does not.
 */
export function hasViewerBridge(
  status: { capabilities?: unknown } | null | undefined,
): boolean {
  const caps = status?.capabilities;
  return Array.isArray(caps) && caps.includes(VIEWER_BRIDGE_CAPABILITY);
}

/**
 * What this server's status reports. `MANOR_E2E_HOST_CAPABILITIES`, when set
 * (comma-separated, possibly empty), replaces it: a **test-only** hook the
 * remote-host E2E uses to stand in for an older server, like
 * `MANOR_E2E_SSH_CONFIG` (`../terminal-host/ssh-config.ts`). Unset in normal
 * use.
 */
export function reportedCapabilities(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env.MANOR_E2E_HOST_CAPABILITIES;
  if (override === undefined) return [...HOST_SERVER_CAPABILITIES];
  return override
    .split(",")
    .map((capability) => capability.trim())
    .filter((capability) => capability !== "");
}
