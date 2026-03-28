import { useState } from "react";
import Link from "lucide-react/dist/esm/icons/link";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { useMountEffect } from "../../hooks/useMountEffect";
import styles from "./SettingsModal/SettingsModal.module.css";

type GitHubStatus = {
  installed: boolean;
  authenticated: boolean;
  username?: string;
};

export function GitHubIntegrationSection() {
  const [status, setStatus] = useState<GitHubStatus | null>(null);

  const checkStatus = () => {
    window.electronAPI.github.checkStatus().then((result) => {
      setStatus(result);
    });
  };

  useMountEffect(checkStatus);

  return (
    <div className={styles.settingsGroup}>
      <div className={styles.sectionTitle}>GitHub</div>
      <div className={styles.sectionDescription}>
        Shows live PR status badges in the sidebar for each branch — including
        CI checks, review decisions, and unresolved comments. Requires the
        GitHub CLI (<code>gh</code>) to be installed and authenticated.
      </div>
      {status?.installed && status?.authenticated ? (
        <div className={styles.linearConnected}>
          <div className={styles.linearStatus}>
            <Link size={14} />
            <span>Connected as {status.username}</span>
          </div>
          <button className={styles.linearButton} onClick={checkStatus}>
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      ) : status?.installed && !status?.authenticated ? (
        <div className={styles.linearDisconnected}>
          <div>GitHub CLI installed but not authenticated.</div>
          <div className={styles.fieldHint}>
            Run <code>gh auth login</code> in your terminal to connect.
          </div>
          <button className={styles.linearButton} onClick={checkStatus}>
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      ) : (
        <div className={styles.linearDisconnected}>
          <div>
            GitHub CLI is required for PR status.{" "}
            <a
              className={styles.linearLink}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.electronAPI.shell.openExternal("https://cli.github.com");
              }}
            >
              Install GitHub CLI
            </a>
          </div>
          <div className={styles.fieldHint}>
            After installing, run <code>gh auth login</code> in your terminal.
          </div>
          <button className={styles.linearButton} onClick={checkStatus}>
            <RefreshCw size={13} />
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
