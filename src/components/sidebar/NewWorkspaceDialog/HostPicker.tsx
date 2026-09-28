import { Fragment } from "react";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import type { WorkspaceHostChoice } from "../../../lib/workspace-host-choices";
import { isRemoteHost } from "../../../lib/hosts";
import { HostIndicator } from "../../hosts/HostIndicator";
import { Button } from "../../ui/Button/Button";
import { Tooltip } from "../../ui/Tooltip/Tooltip";
import { Stack } from "../../ui/Layout/Layout";
import styles from "./NewWorkspaceDialog.module.css";

type HostPickerProps = {
  choices: WorkspaceHostChoice[];
  /** The chosen member project's id. */
  value: string;
  onChange: (projectId: string) => void;
};

/**
 * Where a linked project's new workspace runs (ADR-192): one option per
 * member host, labeled with its host badge. A host that isn't connected
 * stays visible but can't be picked, and its tooltip says why.
 */
export function HostPicker(props: HostPickerProps) {
  const { choices, value, onChange } = props;

  return (
    <Stack>
      <label className={styles.fieldLabel} id="new-workspace-host-label">
        Run on
      </label>
      <div
        className={styles.hostOptions}
        role="radiogroup"
        aria-labelledby="new-workspace-host-label"
        data-testid="new-workspace-host-picker"
      >
        {choices.map((choice) => {
          const disabled = choice.disabledReason !== null;
          const option = (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={choice.projectId === value}
              // aria-disabled, not disabled, so the tooltip still opens on
              // hover and focus.
              aria-disabled={disabled}
              className={`${styles.hostOption} ${
                choice.projectId === value ? styles.hostOptionActive : ""
              }`}
              data-host-id={choice.hostId}
              onClick={() => {
                if (!disabled) onChange(choice.projectId);
              }}
            >
              {isRemoteHost(choice.hostId) ? (
                <HostIndicator hostId={choice.hostId} variant="label" />
              ) : (
                <span className={styles.hostLocal}>
                  <Laptop size={11} aria-hidden />
                  This machine
                </span>
              )}
            </Button>
          );
          return disabled ? (
            <Tooltip key={choice.projectId} label={choice.disabledReason!} side="top">
              {option}
            </Tooltip>
          ) : (
            <Fragment key={choice.projectId}>{option}</Fragment>
          );
        })}
      </div>
    </Stack>
  );
}
