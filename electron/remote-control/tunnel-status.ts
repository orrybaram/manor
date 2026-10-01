/**
 * The light half of `tunnel.ts` (ADR-205 §3): the status types, the stopped
 * status, detection, and the cancel marker.
 *
 * The controller needs all three before remote control is ever turned on — the
 * settings panel renders a tunnel status and asks which tools are installed —
 * but the tunnel manager itself is loaded only when the user enables remote
 * control. Keeping these here lets the controller answer without evaluating
 * `tunnel.ts`, which re-exports the types so existing imports still work.
 */

/**
 * Where the Tailscale app keeps its CLI. The app does not put `tailscale` on
 * PATH, but this binary *is* the CLI when invoked with arguments, and it talks
 * to the app's own daemon — so `serve` works without sudo.
 */
export const TAILSCALE_APP_CLI =
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export type TunnelState = "stopped" | "starting" | "running" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  /** Set only in `running`. */
  url: string | null;
  /** Set only in `failed`. Never contains a token. */
  error: string | null;
  /**
   * Set only in `starting`, when Tailscale is waiting on the user — e.g.
   * "Serve is not enabled on your tailnet. To enable, visit: <url>". The
   * child keeps polling and carries on by itself once the user has been there.
   */
  actionUrl?: string | null;
}

/** Another device on the user's tailnet, as `tailscale status` reports it. */
export interface TailnetPeer {
  name: string;
  os: string;
  online: boolean;
}

/**
 * Who else can reach a `*.ts.net` address. The address only opens on devices
 * in the tailnet, so "no peers" is the usual reason a phone cannot reach it —
 * worth saying on the card rather than leaving the user at "site can't be
 * reached".
 */
export interface TailnetInfo {
  /** The signed-in account, e.g. `someone@example.com`. */
  account: string | null;
  peers: TailnetPeer[];
}

/** What a tunnel that was never started (or has been stopped) reports. */
export const STOPPED_TUNNEL_STATUS: Readonly<TunnelStatus> = Object.freeze({
  state: "stopped",
  url: null,
  error: null,
});

/** `backend.shell.which` — not a second `which` implementation. */
export type WhichFn = (bin: string) => Promise<string | null>;

/**
 * Whether the tailscale CLI was found, on PATH or in the app bundle — the
 * `which` passed in decides where to look.
 */
export async function isTailscaleInstalled(which: WhichFn): Promise<boolean> {
  return (await which("tailscale")) !== null;
}

/**
 * What `start()` rejects with when `stop()` beat it. Marked so the caller can
 * tell a Cancel from a failure without racing on the reported state.
 */
export function cancelled(): Error & { cancelled: true } {
  return Object.assign(new Error("Tunnel start was cancelled"), {
    cancelled: true as const,
  });
}

export function isCancelled(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { cancelled?: unknown }).cancelled === true
  );
}
