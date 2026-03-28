import { useState } from "react";
import Link from "lucide-react/dist/esm/icons/link";
import Unlink from "lucide-react/dist/esm/icons/unlink";
import { useProjectStore } from "../store/project-store";
import { useToastStore } from "../store/toast-store";
import { useMountEffect } from "../hooks/useMountEffect";
import styles from "./SettingsModal.module.css";

export function LinearIntegrationSection() {
  const [connected, setConnected] = useState(false);
  const [viewer, setViewer] = useState<{ name: string; email: string } | null>(
    null,
  );
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const addToast = useToastStore((s) => s.addToast);

  useMountEffect(() => {
    window.electronAPI.linear.isConnected().then(async (isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        try {
          const v = await window.electronAPI.linear.getViewer();
          setViewer(v);
        } catch {
          // token may be stale
        }
      }
    });
  });

  const handleConnect = async () => {
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const v = await window.electronAPI.linear.connect(apiKey.trim());
      setViewer(v);
      setConnected(true);
      setApiKey("");
      // Auto-match projects
      const matches = await window.electronAPI.linear.autoMatch();
      const count = Object.keys(matches).length;
      setMatchCount(count);
      loadProjects();
      addToast({
        id: "linear-connected",
        message: "Linear connected",
        detail:
          count > 0
            ? `Auto-matched ${count} project${count !== 1 ? "s" : ""}`
            : undefined,
        status: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await window.electronAPI.linear.disconnect();
    setConnected(false);
    setViewer(null);
    setMatchCount(null);
  };

  return (
    <div className={styles.settingsGroup}>
      <div className={styles.sectionTitle}>Linear</div>
      <div className={styles.sectionDescription}>
        Connect Linear to sync issues, track project progress, and auto-match
        teams to your projects.
      </div>
      {connected ? (
        <div className={styles.linearConnected}>
          <div className={styles.linearStatus}>
            <Link size={14} />
            <span>Connected as {viewer?.name ?? "..."}</span>
          </div>
          {matchCount !== null && matchCount > 0 && (
            <div className={styles.linearMatchInfo}>
              Auto-matched {matchCount} project{matchCount !== 1 ? "s" : ""} to
              Linear teams
            </div>
          )}
          <button className={styles.linearButton} onClick={handleDisconnect}>
            <Unlink size={13} />
            Disconnect
          </button>
        </div>
      ) : (
        <div className={styles.linearDisconnected}>
          <div className={styles.linearInputRow}>
            <input
              className={styles.fieldInput}
              type="password"
              placeholder="Paste your Linear API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect();
              }}
            />
            <button
              className={styles.linearButton}
              onClick={handleConnect}
              disabled={loading || !apiKey.trim()}
            >
              {loading ? "Connecting..." : "Connect"}
            </button>
          </div>
          {error && <div className={styles.linearError}>{error}</div>}
          <div className={styles.fieldHint}>
            Get your API key from{" "}
            <a
              className={styles.linearLink}
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.electronAPI.shell.openExternal(
                  "https://linear.app/trytango/settings/account/security",
                );
              }}
            >
              Linear Settings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
