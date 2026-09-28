import { useId } from "react";
import type { WorkspaceHostChoice } from "../../../lib/workspace-host-choices";
import { isRemoteHost } from "../../../lib/hosts";
import { HostIndicator, LocalHostLabel } from "../../hosts/HostIndicator";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Stack } from "../../ui/Layout/Layout";
import styles from "./NewWorkspaceDialog.module.css";

type HostPickerProps = {
  choices: WorkspaceHostChoice[];
  /** The chosen member project's id. */
  value: string;
  onChange: (projectId: string) => void;
};

/**
 * Where a linked project's new workspace runs (ADR-192). It shows one
 * option per member host, labeled with that host's badge. A host that
 * isn't connected stays visible but can't be picked, and says why.
 */
export function HostPicker(props: HostPickerProps) {
  const { choices, value, onChange } = props;

  const labelId = useId();

  return (
    <Stack>
      <span className={styles.fieldLabel} id={labelId}>
        Run on
      </span>
      <ToggleGroup
        value={value}
        onChange={onChange}
        size="sm"
        aria-labelledby={labelId}
        data-testid="new-workspace-host-picker"
        options={choices.map((choice) => ({
          value: choice.projectId,
          label: isRemoteHost(choice.hostId) ? (
            <HostIndicator hostId={choice.hostId} variant="label" />
          ) : (
            <LocalHostLabel />
          ),
          ...(choice.disabledReason ? { disabledReason: choice.disabledReason } : {}),
        }))}
      />
    </Stack>
  );
}
