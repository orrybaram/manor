import { usePreferencesStore } from "../../store/preferences-store";
import type { HarnessKind } from "../../lib/harness";
import { Input, Select } from "../ui/Input";
import { Stack } from "../ui/Layout/Layout";
import { SectionTitle } from "./SectionTitle";
import { isWebApp } from "../../lib/platform";
import styles from "./SettingsModal/SettingsModal.module.css";

export function HomeSettingsPage() {
  const { preferences, set } = usePreferencesStore();
  // `preferences.set` isn't on the slice-1 bridge table (ADR-178): Home's
  // agent command is the same kind of machine config as a project's, and
  // gets the same read-only treatment.
  const webApp = isWebApp();

  const handleHarnessChange = (value: string) => {
    set("homeHarness", value as HarnessKind);
  };

  return (
    <Stack className={styles.pageContent}>
      {webApp && (
        <div className={styles.sectionDescription}>
          Home&apos;s agent command isn&apos;t editable from the browser yet
          — shown read-only.
        </div>
      )}
      <Stack gap="xs">
        <SectionTitle id="home-harness">Harness</SectionTitle>
        <div className={styles.fieldLabel}>Agent harness</div>
        <Select
          value={preferences.homeHarness}
          disabled={webApp}
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
              disabled={webApp}
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
              disabled={webApp}
              onChange={(e) => set("homeCustomInterrupt", e.target.value)}
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
