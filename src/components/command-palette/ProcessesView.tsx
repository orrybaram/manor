import { useState, useCallback } from "react";
import { Command } from "cmdk";
import * as Dialog from "@radix-ui/react-dialog";
import Activity from "lucide-react/dist/esm/icons/activity";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Globe from "lucide-react/dist/esm/icons/globe";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import X from "lucide-react/dist/esm/icons/x";
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

const INTERNAL_SERVER_DESCRIPTIONS: Record<string, string> = {
  agentHookServer: "Receives lifecycle events from AI agents",
  webviewServer: "Inspection and interaction API for browser panes",
  portlessManager: "Routes .localhost hostnames to dev server ports",
};

export function ProcessesView() {
  const [info, setInfo] = useState<ManorProcessInfo | null>(null);
  const [cleaningUp, setCleaningUp] = useState(false);

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

  const handleRestartPortless = useCallback(async () => {
    await window.electronAPI.processes.restartPortless();
    void fetchInfo();
  }, [fetchInfo]);

  const handleCleanupDead = useCallback(async () => {
    setCleaningUp(true);
    const { success } = await window.electronAPI.processes.cleanupDead();
    await fetchInfo();
    if (!success) {
      // Daemon unreachable — filter dead sessions client-side
      setInfo((prev) =>
        prev
          ? { ...prev, sessions: prev.sessions.filter((s) => s.alive) }
          : prev,
      );
    }
    setCleaningUp(false);
  }, [fetchInfo]);

  if (!info) {
    return <div className={styles.empty}>Loading...</div>;
  }

  const { daemon, internalServers, sessions, ports } = info;
  const hasDeadSessions = sessions.some((s) => !s.alive);

  return (
    <>
      {/* ── Daemon ── */}
      <Command.Group heading="Daemon" className={styles.group}>
        <div className={styles.sectionDescription}>
          Keeps terminal sessions alive across app restarts
        </div>
        <Command.Item
          value={`daemon Terminal Host Daemon ${daemon.pid ?? ""}`}
          className={styles.processCard}
          onSelect={() => {}}
        >
          <div className={styles.processCardHeader}>
            <span className={styles.processCardIcon}>
              <Activity size={16} />
            </span>
            <span className={styles.processCardTitle} style={daemon.alive ? undefined : { opacity: 0.4 }}>
              Terminal Host
            </span>
            {daemon.alive ? (
              <span className={styles.statusAlive} />
            ) : (
              <span className={styles.statusDead} />
            )}
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
          </div>
          {daemon.pid != null && (
            <span className={styles.processCardDetail}>PID {daemon.pid}</span>
          )}
        </Command.Item>
      </Command.Group>

      {/* ── Internal Services ── */}
      <Command.Group heading="Services" className={styles.group}>
        <div className={styles.sectionDescription}>
          Internal servers that power Manor features
        </div>
        {internalServers.map((server) => {
          const displayName = INTERNAL_SERVER_NAMES[server.name] ?? server.name;
          const description = INTERNAL_SERVER_DESCRIPTIONS[server.name] ?? "";
          return (
            <Command.Item
              key={server.name}
              value={`internal server ${displayName} ${server.port ?? ""}`}
              className={styles.processCard}
              onSelect={() => {}}
            >
              <div className={styles.processCardHeader}>
                <span className={styles.processCardIcon}>
                  <Globe size={16} />
                </span>
                <span className={styles.processCardTitle}>
                  {displayName}
                </span>
                {server.port != null && (
                  <span className={styles.processCardPort}>:{server.port}</span>
                )}
                {server.name === "portlessManager" && (
                  <Tooltip label="Restart proxy" side="top">
                    <button
                      className={styles.processKill}
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRestartPortless();
                      }}
                    >
                      <RefreshCw size={12} />
                    </button>
                  </Tooltip>
                )}
              </div>
              {description && (
                <span className={styles.processCardDetail}>{description}</span>
              )}
            </Command.Item>
          );
        })}
      </Command.Group>

      {/* ── Sessions ── */}
      <Command.Group
        heading={
          (
            <span style={{ display: "flex", alignItems: "center", width: "100%" }}>
              Sessions
              {hasDeadSessions && (
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ marginLeft: "auto" }}
                  tabIndex={-1}
                  disabled={cleaningUp}
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCleanupDead();
                  }}
                >
                  {cleaningUp ? "Cleaning..." : "Clean Up"}
                </Button>
              )}
            </span>
          ) as unknown as string
        }
        className={styles.group}
      >
        <div className={styles.sectionDescription}>
          Each terminal pane runs in its own isolated subprocess
        </div>
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

      {/* ── Ports ── */}
      <Command.Group heading="Ports" className={styles.group}>
        <div className={styles.sectionDescription}>
          TCP ports listening on localhost
        </div>
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
