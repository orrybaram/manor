import { useId } from "react";
import type { WorkspaceHostChoice } from "../../../lib/workspace-host-choices";
import { isRemoteHost } from "../../../lib/hosts";
import type { NewHostTarget } from "../../../lib/transfer-targets";
import { HostIndicator, LocalHostLabel } from "../../hosts/HostIndicator";
import { ToggleGroup } from "../../ui/ToggleGroup";
import { Button } from "../../ui/Button/Button";
import { Row, Stack } from "../../ui/Layout/Layout";
import styles from "./NewWorkspaceDialog.module.css";

type HostPickerProps = {
  choices: WorkspaceHostChoice[];
  /** The chosen member project's id. */
  value: string;
  onChange: (projectId: string) => void;
  /**
   * Opens "Set up on another host…" (ADR-192 ticket 4). Omitted when every
   * registered host already has a member, which hides the action.
   */
  onSetUpOnAnotherHost?: () => void;
  /** Whether other projects' hosts are being left out of "Set up on another host…". */
  showHiddenHostsToggle?: boolean;
  showAllHosts?: boolean;
  onToggleShowAllHosts?: () => void;
  /** "In a new pod · <profile>" entries (ADR-235 D4), after the hosts. */
  newHostTargets?: NewHostTarget[];
  onSetUpInNewHost?: (target: NewHostTarget) => void;
};

/**
 * Where a project's new workspace runs (ADR-192). It shows one
 * option per host the project is set up on, labeled with that host's badge. A host that
 * isn't connected stays visible but can't be picked, and says why. Beside
 * it, "Set up on another host…" sets the project up on a host it lacks.
 */
export function HostPicker(props: HostPickerProps) {
  const {
    choices,
    value,
    onChange,
    onSetUpOnAnotherHost,
    newHostTargets = [],
    onSetUpInNewHost,
    showHiddenHostsToggle,
    showAllHosts,
    onToggleShowAllHosts,
  } = props;

  const labelId = useId();

  return (
    <Stack>
      <span className={styles.fieldLabel} id={labelId}>
        Run on
      </span>
      <Row gap="sm" align="center" className={styles.hostPickerRow}>
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
        {onSetUpOnAnotherHost && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onSetUpOnAnotherHost}
            data-testid="new-workspace-set-up-on-host"
          >
            Set up on another host…
          </Button>
        )}
        {onSetUpInNewHost &&
          newHostTargets.map((target) => (
            <Button
              key={target.profileId}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onSetUpInNewHost(target)}
              data-testid="new-workspace-set-up-in-new-pod"
            >
              {target.label}
            </Button>
          ))}
        {showHiddenHostsToggle && onToggleShowAllHosts && (
          <Button
            variant="link"
            type="button"
            onClick={onToggleShowAllHosts}
            data-testid="new-workspace-show-all-hosts"
          >
            {showAllHosts ? "Hide other projects' hosts" : "Show all hosts"}
          </Button>
        )}
      </Row>
    </Stack>
  );
}
