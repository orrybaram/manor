/**
 * Normalize a caught `unknown` value to a message, stripping Electron's
 * "Error invoking remote method '…': <Name>Error: " wrapper so the renderer
 * shows the underlying error instead of IPC plumbing.
 */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}
