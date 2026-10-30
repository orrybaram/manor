import { useMemo } from "react";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Laptop from "lucide-react/dist/esm/icons/laptop";
import Plus from "lucide-react/dist/esm/icons/plus";
import type { WorkspaceHostChoice } from "../../../lib/workspace-host-choices";
import { isRemoteHost, memberHostName } from "../../../lib/hosts";
import type { NewHostTarget } from "../../../lib/transfer-targets";
import { serverHostName } from "../../../bridge/server-set";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { useHostStore } from "../../../store/host-store";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import {
  SearchableSelect,
  type SearchableSelectAction,
} from "../../ui/SearchableSelect";
import styles from "./NewWorkspaceDialog.module.css";

type HostPickerProps = {
  choices: WorkspaceHostChoice[];
  /** The chosen member project's id. */
  value: string;
  onChange: (projectId: string) => void;
  /**
   * Opens "Set up on another host…". Omitted when every
   * registered host already has a member, which hides the action.
   */
  onSetUpOnAnotherHost?: () => void;
  /** Whether other projects' hosts are being left out of "Set up on another host…". */
  showHiddenHostsToggle?: boolean;
  showAllHosts?: boolean;
  onToggleShowAllHosts?: () => void;
  /** "In a new pod · <profile>" entries, after the hosts. */
  newHostTargets?: NewHostTarget[];
  onSetUpInNewHost?: (target: NewHostTarget) => void;
};

/** This machine's laptop, or a remote host's cloud in its current state. */
function HostGlyph(props: { hostId: string }) {
  const { hostId } = props;

  const display = useHostDisplay(hostId);
  if (!isRemoteHost(hostId)) return <Laptop size={12} aria-hidden />;
  return display ? (
    <HostStateIcon display={display} size={12} />
  ) : (
    <Cloud size={12} aria-hidden />
  );
}

/**
 * Where a project's new workspace runs: a chip whose list has one row per
 * host the project is set up on. A host that isn't connected stays listed
 * but can't be picked, and says why. The rows after the hosts set the
 * project up on a host it lacks.
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

  const hosts = useHostStore((s) => s.hosts);

  const options = useMemo(
    () =>
      choices.map((choice) => ({
        value: choice.projectId,
        label:
          serverHostName(choice.hostId) ?? memberHostName(choice.hostId, hosts),
        icon: <HostGlyph hostId={choice.hostId} />,
        disabledReason: choice.disabledReason,
      })),
    [choices, hosts],
  );

  const actions: SearchableSelectAction[] = [
    ...(onSetUpOnAnotherHost
      ? [
          {
            label: "Set up on another host…",
            icon: <Plus size={12} />,
            onSelect: onSetUpOnAnotherHost,
            "data-testid": "new-workspace-set-up-on-host",
          },
        ]
      : []),
    ...(onSetUpInNewHost
      ? newHostTargets.map((target) => ({
          label: target.label,
          icon: <Plus size={12} />,
          onSelect: () => onSetUpInNewHost(target),
          "data-testid": "new-workspace-set-up-in-new-pod",
        }))
      : []),
    ...(showHiddenHostsToggle && onToggleShowAllHosts
      ? [
          {
            label: showAllHosts ? "Hide other projects' hosts" : "Show all hosts",
            onSelect: onToggleShowAllHosts,
            "data-testid": "new-workspace-show-all-hosts",
          },
        ]
      : []),
  ];

  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      options={options}
      actions={actions}
      searchPlaceholder="Search hosts..."
      className={styles.chip}
      maxWidth={180}
      aria-label="Run on"
      data-testid="new-workspace-host-picker"
    />
  );
}
