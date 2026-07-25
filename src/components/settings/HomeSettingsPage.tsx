import { usePreferencesStore } from "../../store/preferences-store";
import type { HarnessKind } from "../../lib/harness";
import { Input, Select } from "../ui/Input";
import { Stack } from "../ui/Layout/Layout";
import styles from "./SettingsModal/SettingsModal.module.css";

export function HomeSettingsPage() {
  const { preferences, set } = usePreferencesStore();

  const handleHarnessChange = (value: string) => {
    set("homeHarness", value as HarnessKind);
  };

  return (
    <Stack className={styles.pageContent}>
      <Stack gap="xs">
        <div className={styles.sectionTitle}>Harness</div>
        <div className={styles.fieldLabel}>Agent harness</div>
        <Select
          value={preferences.homeHarness}
          onChange={(e) => handleHarnessChange(e.target.value)}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="custom">Custom</option>
        </Select>
        <div className={styles.fieldHint}>
          The CLI Home auto-launches for its always-on session.
        </div>

        {preferences.homeHarness === "custom" && (
          <>
            <div className={styles.fieldLabel}>Launch command</div>
            <Input
              type="text"
              placeholder="e.g. my-agent --flag"
              value={preferences.homeCustomCommand}
              onChange={(e) => set("homeCustomCommand", e.target.value)}
            />
            <div className={styles.fieldHint}>
              Full boot command for your custom harness.
            </div>

            <div className={styles.fieldLabel}>Interrupt sequence</div>
            <Input
              type="text"
              placeholder={"e.g. \\x03 for Ctrl-C"}
              value={preferences.homeCustomInterrupt}
              onChange={(e) =>
                set("homeCustomInterrupt", e.target.value)
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
