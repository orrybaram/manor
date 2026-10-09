import { useState } from "react";
import LinkIcon from "lucide-react/dist/esm/icons/link";
import Unlink from "lucide-react/dist/esm/icons/unlink";
import { useToastStore } from "../../store/toast-store";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Button } from "../ui/Button/Button";
import { Link } from "../ui/Link/Link";
import { Input } from "../ui/Input";
import { Stack, Row } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import styles from "./SettingsModal/SettingsModal.module.css";

export function TypeSafeIntegrationSection() {
  const [connected, setConnected] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  useMountEffect(() => {
    window.electronAPI.typesafe.isConnected().then(setConnected);
  });

  const handleConnect = async () => {
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await window.electronAPI.typesafe.connect(apiKey.trim());
      setConnected(true);
      setApiKey("");
      addToast({
        id: "typesafe-connected",
        message: "TypeSafe (Jev) connected",
        status: "success",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await window.electronAPI.typesafe.disconnect();
    setConnected(false);
  };

  return (
    <Stack gap="xs">
      <SectionTitle id="integrations-typesafe">TypeSafe (Jev)</SectionTitle>
      <div className={styles.sectionDescription}>
        Suggests a sidebar folder for new workspaces. The workspace name,
        branch, agent prompt and your folder and workspace names are sent to
        TypeSafe.
      </div>
      {connected ? (
        <Stack gap="sm">
          <div className={styles.linearStatus}>
            <LinkIcon size={14} />
            <span>Connected</span>
          </div>
          <Button
            variant="secondary"
            className={styles.linearButton}
            onClick={handleDisconnect}
          >
            <Unlink size={13} />
            Disconnect
          </Button>
        </Stack>
      ) : (
        <Stack gap="xxs">
          <Row gap="sm">
            <Input
              type="password"
              placeholder="Paste your TypeSafe API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleConnect();
              }}
            />
            <Button
              variant="secondary"
              className={styles.linearButton}
              onClick={handleConnect}
              disabled={loading || !apiKey.trim()}
            >
              {loading ? "Connecting..." : "Connect"}
            </Button>
          </Row>
          {error && <div className={styles.linearError}>{error}</div>}
          <div className={styles.fieldHint}>
            Get your API key from{" "}
            <Link href="https://typesafe.ai">TypeSafe</Link>.
          </div>
        </Stack>
      )}
    </Stack>
  );
}
