import { useMemo } from "react";
import type { ActivePort } from "../../../electron.d";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { formatCombo } from "../../../lib/keybindings";
import { portUrl } from "../../../lib/port-forward-open";
import { workspaceKey as keyOf, type WorkspaceKey } from "../../../lib/workspace-key";
import { useKeybinding } from "../../../store/keybindings-store";
import { acquirePortsScanner, usePortsStore } from "../../../store/ports-store";
import styles from "./BrowserPane.module.css";

type BlankPageProps = {
  /** The pane's workspace, whose detected ports are listed. */
  workspaceKey?: WorkspaceKey;
  /** Load a port's URL in the pane (a remote host's goes through its forward). */
  onOpen: (url: string) => void;
};

/**
 * A blank pane: the dev servers detected in its workspace, one click each,
 * or just the prompt to type a URL when there are none.
 */
export function BlankPage(props: BlankPageProps) {
  const { workspaceKey, onOpen } = props;

  // The ports scanner is shared: held while a blank pane shows.
  useMountEffect(() => acquirePortsScanner());
  const ports = usePortsStore((s) => s.ports);
  const servers = useMemo(
    () =>
      workspaceKey
        ? ports
            .filter((p) => p.workspacePath && keyOf(p.hostId, p.workspacePath) === workspaceKey)
            .sort((a, b) => a.port - b.port)
        : [],
    [ports, workspaceKey],
  );
  const focusUrl = useKeybinding("browser-focus-url");

  if (servers.length === 0) {
    return <div className={styles.emptyState}>Enter a URL to get started</div>;
  }

  return (
    <div className={styles.statePage} data-testid="browser-blank-servers">
      <span className={styles.stateDetail}>Running in this workspace</span>
      <div className={styles.serverList}>
        {servers.map((port) => (
          <ServerRow key={`${port.hostId}:${port.port}`} port={port} onOpen={onOpen} />
        ))}
      </div>
      <span className={styles.serverHint}>
        or type a URL above
        {focusUrl && (
          <>
            {" · "}
            <kbd className={styles.serverKey}>{formatCombo(focusUrl)}</kbd>
          </>
        )}
      </span>
    </div>
  );
}

function ServerRow(props: { port: ActivePort; onOpen: (url: string) => void }) {
  const { port, onOpen } = props;
  const url = portUrl(port);
  const label = port.hostname ?? `localhost:${port.port}`;
  return (
    <button
      type="button"
      className={styles.serverRow}
      title={`Open ${label}`}
      aria-label={`Open ${label}`}
      onClick={() => onOpen(url)}
    >
      <span className={styles.serverDot} aria-hidden />
      <span className={styles.serverHost}>{label}</span>
      <span className={styles.serverProcess}>{port.processName}</span>
    </button>
  );
}
