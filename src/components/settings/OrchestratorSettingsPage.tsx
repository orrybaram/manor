import { usePreferencesStore } from "../../store/preferences-store";
import type { HarnessKind } from "../../lib/harness";
import { Input, Select } from "../ui/Input";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function OrchestratorSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  const handleHarnessChange = (value: string) => {
    set("orchestratorHarness", value as HarnessKind);
  };

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <div className={styles.sectionTitle}>Harness</div>
        <div className={styles.fieldLabel}>Agent harness</div>
        <Select
          value={preferences.orchestratorHarness}
          onChange={(e) => handleHarnessChange(e.target.value)}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="custom">Custom</option>
        </Select>
        <div className={styles.fieldHint}>
          The CLI the orchestrator auto-launches for its always-on session.
        </div>

        {preferences.orchestratorHarness === "custom" && (
          <>
            <div className={styles.fieldLabel}>Launch command</div>
            <Input
              type="text"
              placeholder="e.g. my-agent --flag"
              value={preferences.orchestratorCustomCommand}
              onChange={(e) => set("orchestratorCustomCommand", e.target.value)}
            />
            <div className={styles.fieldHint}>
              Full boot command for your custom harness.
            </div>

            <div className={styles.fieldLabel}>Interrupt sequence</div>
            <Input
              type="text"
              placeholder={"e.g. \\x03 for Ctrl-C"}
              value={preferences.orchestratorCustomInterrupt}
              onChange={(e) =>
                set("orchestratorCustomInterrupt", e.target.value)
              }
            />
            <div className={styles.fieldHint}>
              Raw pty bytes sent to gracefully end the harness's current turn
              before steering it. Defaults to Ctrl-C when left empty.
            </div>
          </>
        )}
      </Stack>
    </Stack>
  );
}
