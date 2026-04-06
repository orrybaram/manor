import { useState, useCallback } from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import Activity from "lucide-react/dist/esm/icons/activity";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import X from "lucide-react/dist/esm/icons/x";
import Info from "lucide-react/dist/esm/icons/info";
import type { ManorProcessInfo } from "../../electron.d";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Tooltip } from "../ui/Tooltip/Tooltip";
import { Button } from "../ui/Button/Button";
import styles from "./CommandPalette.module.css";
import dialogStyles from "../sidebar/dialogs.module.css";

export function KillAllFooter({ onKillAll }: { onKillAll: () => Promise<void> }) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <div className={styles.detailFooter}>
        <button
          className={`${styles.footerHint} ${styles.footerHintDanger}`}
          onClick={() => setConfirmOpen(true)}
        >
          Kill All
        </button>
      </div>

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={dialogStyles.confirmOverlay} />
          <Dialog.Content className={dialogStyles.confirmDialog}>
            <Dialog.Title className={dialogStyles.confirmTitle}>
              Kill All Processes
            </Dialog.Title>
            <Dialog.Description className={dialogStyles.confirmDescription}>
              This will kill the daemon, all terminal sessions, and any
              listening ports. You may need to restart Manor to restore
              full functionality.
            </Dialog.Description>
            <div className={dialogStyles.confirmActions}>
              <Button
                variant="secondary"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmOpen(false);
                  void onKillAll();
                }}
              >
                Kill All
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

const INTERNAL_SERVER_NAMES: Record<string, string> = {
  agentHookServer: "Agent Hook Server",
  webviewServer: "Webview Server",
  portlessManager: "Portless Proxy",
};

const INTERNAL_SERVER_TOOLTIPS: Record<string, string> = {
  agentHookServer: "Receives lifecycle events from AI agents like Claude Code",
  webviewServer: "Provides inspection and interaction API for browser panes",
  portlessManager: "Routes .localhost hostnames to your local dev server ports",
};

export function ProcessesView() {
  const [info, setInfo] = useState<ManorProcessInfo | null>(null);

  const fetchInfo = useCallback(async () => {
    try {
      const data = await window.electronAPI.processes.list();
      setInfo(data);
    } catch {
      // ignore
    }
  }, []);

  useMountEffect(() => {
    void fetchInfo();
  });

  const handleKillDaemon = useCallback(async () => {
    await window.electronAPI.processes.killDaemon();
    void fetchInfo();
  }, [fetchInfo]);

  const handleKillSession = useCallback(
    async (sessionId: string) => {
      await window.electronAPI.processes.killSession(sessionId);
      void fetchInfo();
    },
    [fetchInfo],
  );

  const handleKillPort = useCallback(
    async (pid: number) => {
      await window.electronAPI.ports.killPort(pid);
      void fetchInfo();
    },
    [fetchInfo],
  );

  const handleCleanupDead = useCallback(async () => {
    await window.electronAPI.processes.cleanupDead();
    void fetchInfo();
  }, [fetchInfo]);

  if (!info) {
    return <div className={styles.empty}>Loading...</div>;
  }

  const { daemon, internalServers, sessions, ports } = info;
  const hasDeadSessions = sessions.some((s) => !s.alive);

  return (
    <>
      <Command.Group heading="Manor Internal" className={styles.group}>
        <Command.Item
          value={`daemon Terminal Host Daemon ${daemon.pid ?? ""}`}
          className={styles.item}
          onSelect={() => {}}
        >
          <span className={styles.icon}>
            <Activity size={14} />
          </span>
          <span
            className={styles.label}
            style={daemon.alive ? undefined : { opacity: 0.4 }}
          >
            Terminal Host Daemon{daemon.pid != null ? ` — PID ${daemon.pid}` : ""}
          </span>
          {daemon.alive ? (
            <span className={styles.statusAlive} />
          ) : (
            <span className={styles.statusDead} />
          )}
          <Tooltip label="Background process that keeps your terminal sessions alive across app restarts" side="top">
            <button
              className={styles.processInfo}
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              <Info size={12} />
            </button>
          </Tooltip>
          {daemon.alive && (
            <Tooltip label="Kill daemon" side="top">
              <button
                className={styles.processKill}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleKillDaemon();
                }}
              >
                <X size={12} />
              </button>
            </Tooltip>
          )}
        </Command.Item>

        {internalServers.map((server) => {
          const displayName = INTERNAL_SERVER_NAMES[server.name] ?? server.name;
          const tooltip = INTERNAL_SERVER_TOOLTIPS[server.name] ?? "";
          return (
            <Command.Item
              key={server.name}
              value={`internal server ${displayName} ${server.port ?? ""}`}
              className={styles.item}
              onSelect={() => {}}
            >
              <span className={styles.icon}>
                <Globe size={14} />
              </span>
              <span className={styles.label}>
                {displayName}
                {server.port != null ? ` — :${server.port}` : ""}
              </span>
              <Tooltip label={tooltip} side="top">
                <button
                  className={styles.processInfo}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Info size={12} />
                </button>
              </Tooltip>
            </Command.Item>
          );
        })}
      </Command.Group>

      <Command.Group
        heading={
          (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              Sessions
              <Tooltip label="Each terminal pane runs in its own isolated subprocess" side="right">
                <button
                  className={styles.processInfo}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Info size={12} />
                </button>
              </Tooltip>
              {hasDeadSessions && (
                <button
                  className={styles.processCleanup}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCleanupDead();
                  }}
                >
                  Clean Up
                </button>
              )}
            </span>
          ) as unknown as string
        }
        className={styles.group}
      >
        {sessions.length === 0 ? (
          <div className={styles.empty}>No active sessions</div>
        ) : (
          sessions.map((session) => {
            const shortId = session.sessionId.slice(0, 8);
            const cwd = session.cwd
              ? session.cwd.split("/").filter(Boolean).pop() ?? session.cwd
              : null;
            return (
              <Command.Item
                key={session.sessionId}
                value={`session ${session.sessionId} ${cwd ?? ""}`}
                className={styles.item}
                onSelect={() => {}}
              >
                <span className={styles.icon}>
                  <Terminal size={14} />
                </span>
                <span
                  className={styles.label}
                  style={session.alive ? undefined : { opacity: 0.4 }}
                >
                  {shortId}
                  {cwd ? ` — ${cwd}` : ""}
                </span>
                {session.alive ? (
                  <span className={styles.statusAlive} />
                ) : (
                  <span className={styles.statusDead} />
                )}
                {session.alive && (
                  <Tooltip label="Kill session" side="top">
                    <button
                      className={styles.processKill}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleKillSession(session.sessionId);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </Tooltip>
                )}
              </Command.Item>
            );
          })
        )}
      </Command.Group>

      <Command.Group
        heading={
          (
            <span style={{ display: "inline-flex", alignItems: "center" }}>
              Ports
              <Tooltip label="TCP ports listening on localhost, typically dev servers" side="right">
                <button
                  className={styles.processInfo}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Info size={12} />
                </button>
              </Tooltip>
            </span>
          ) as unknown as string
        }
        className={styles.group}
      >
        {ports.length === 0 ? (
          <div className={styles.empty}>No listening ports</div>
        ) : (
          ports.map((p) => (
            <Command.Item
              key={`${p.port}-${p.pid}`}
              value={`port ${p.port} ${p.processName} ${p.pid}`}
              className={styles.item}
              onSelect={() => {}}
            >
              <span className={styles.icon}>
                <Globe size={14} />
              </span>
              <span className={styles.label}>
                :{p.port} — {p.processName}
              </span>
              <span className={styles.processMeta}>PID {p.pid}</span>
              <Tooltip label={`Kill PID ${p.pid}`} side="top">
                <button
                  className={styles.processKill}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleKillPort(p.pid);
                  }}
                >
                  <X size={12} />
                </button>
              </Tooltip>
            </Command.Item>
          ))
        )}
      </Command.Group>

    </>
  );
}
