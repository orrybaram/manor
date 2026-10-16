import * as Popover from "@radix-ui/react-popover";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import { useHostDisplay } from "../../../hooks/useHostDisplay";
import { groupHostsByProfile, runningSummary } from "../../../lib/host-groups";
import { hostName } from "../../../lib/hosts";
import { useHostProfileStore } from "../../../store/host-profile-store";
import { useHostStore } from "../../../store/host-store";
import { Button } from "../../ui/Button/Button";
import { HostIndicator } from "../../hosts/HostIndicator";
import { HostStateIcon } from "../../hosts/HostStateIcon";
import indicatorStyles from "../../hosts/HostIndicator.module.css";
import popoverStyles from "../../hosts/HostPopover.module.css";
import styles from "./HostGroupChips.module.css";

/**
 * A profile's hosts in the status bar (ADR-235 D7): one chip per profile,
 * "<profile>: N of M running", opening to the hosts it covers. A host in
 * `error` is also shown on its own, so a failure is never folded away.
 * Nothing at all when no host came from a profile.
 *
 * `skipHostId` is the host the active workspace's own chip already names.
 */
export function HostGroupChips(props: { skipHostId?: string | null }) {
  const { skipHostId } = props;
  const hosts = useHostStore((s) => s.hosts);
  const profiles = useHostProfileStore((s) => s.profiles);
  const { groups, errored } = groupHostsByProfile(
    hosts.filter((h) => h.spec !== null),
    profiles,
  );

  return (
    <>
      {groups.map((group) => (
        <Popover.Root key={group.profile.id}>
          <Popover.Trigger asChild>
            <Button
              variant="link"
              className={`${indicatorStyles.chip} ${indicatorStyles.clickable}`}
              data-testid={`host-group-chip-${group.profile.id}`}
            >
              <Cloud size={11} aria-hidden />
              <span className={indicatorStyles.target}>
                {group.profile.name}: {runningSummary(group)}
              </span>
            </Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className={popoverStyles.popover}
              side="top"
              align="end"
              sideOffset={6}
              collisionPadding={8}
              data-testid="host-group-popover"
            >
              {group.hosts.map((host) => (
                <GroupHostLine key={host.hostId} hostId={host.hostId} name={hostName(host)} />
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ))}
      {errored
        .filter((h) => h.hostId !== skipHostId)
        .map((host) => (
          <HostIndicator key={host.hostId} hostId={host.hostId} variant="chip" />
        ))}
    </>
  );
}

function GroupHostLine(props: { hostId: string; name: string }) {
  const display = useHostDisplay(props.hostId);
  return (
    <div className={styles.line} data-testid="host-group-line">
      {display && <HostStateIcon display={display} size={12} />}
      <span className={styles.name}>{props.name}</span>
      <span className={styles.state}>{display?.status ?? ""}</span>
    </div>
  );
}
