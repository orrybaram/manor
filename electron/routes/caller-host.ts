/**
 * The one rule for requests relayed from a remote host's `manor` CLI
 * (ADR-189 §2): such a caller sees and acts only on its own host. Another
 * host's projects, members and hosts answer as if they weren't there.
 * A local caller (no `callerHostId`) sees every host.
 */
export function callerMaySee(
  callerHostId: string | undefined,
  hostId: string | null | undefined,
): boolean {
  if (!callerHostId) return true;
  return hostId === callerHostId;
}
