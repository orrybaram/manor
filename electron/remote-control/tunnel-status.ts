/**
 * The light half of `tunnel.ts` (ADR-205 §3): the status types, the stopped
 * status, and PATH detection.
 *
 * The controller needs all three before remote control is ever turned on — the
 * settings panel renders a tunnel status and asks which tools are installed —
 * but the tunnel manager itself is loaded only when the user enables remote
 * control. Keeping these here lets the controller answer without evaluating
 * `tunnel.ts`, which re-exports the types so existing imports still work.
 */

export type TunnelKind = "tailscale" | "cloudflared";
export type TunnelState = "stopped" | "starting" | "running" | "failed";

export interface TunnelStatus {
  state: TunnelState;
  kind: TunnelKind | null;
  /** Set only in `running`. */
  url: string | null;
  /** Set only in `failed`. Never contains a token. */
  error: string | null;
}

/** What a tunnel that was never started (or has been stopped) reports. */
export const STOPPED_TUNNEL_STATUS: Readonly<TunnelStatus> = Object.freeze({
  state: "stopped",
  kind: null,
  url: null,
  error: null,
});

/** `backend.shell.which` — not a second `which` implementation. */
export type WhichFn = (bin: string) => Promise<string | null>;

/** Which tunnel binaries are on PATH. Manor installs neither. */
export async function detectTunnelTools(
  which: WhichFn,
): Promise<Record<TunnelKind, boolean>> {
  const [tailscale, cloudflared] = await Promise.all([
    which("tailscale"),
    which("cloudflared"),
  ]);
  return { tailscale: tailscale !== null, cloudflared: cloudflared !== null };
}
