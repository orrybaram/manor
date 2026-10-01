import { useState, type ReactElement } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useHostDisplay } from "../../hooks/useHostDisplay";
import { Button } from "../ui/Button/Button";
import { requestUi } from "../../utils/ui-request";
import { HostRetryButton, HostStatusDetails } from "./HostStatusDetails";
import styles from "./HostPopover.module.css";

type HostPopoverProps = {
  hostId: string;
  /** The project to open Host settings for; without it there is no link. */
  projectId?: string;
  side?: "top" | "right" | "bottom" | "left";
  /** The trigger: a DOM element or a ref-forwarding component (`Button`). */
  children: ReactElement;
};

/**
 * What a host chip or icon opens: the host's state in plain words, Retry,
 * and a way to its settings. The chip itself only names the host.
 */
export function HostPopover(props: HostPopoverProps) {
  const { hostId, projectId, side = "top", children } = props;

  const display = useHostDisplay(hostId);
  const [open, setOpen] = useState(false);

  if (!display) return children;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side={side}
          align={side === "top" || side === "bottom" ? "end" : "start"}
          sideOffset={6}
          collisionPadding={8}
          data-testid="host-popover"
          // Portal content still bubbles React events to the row it sits in,
          // which toggles or selects on click.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <HostStatusDetails display={display} />
          {(display.canRetry || projectId) && (
            <div className={styles.actions}>
              {display.canRetry && <HostRetryButton hostId={hostId} />}
              {projectId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setOpen(false);
                    requestUi({ type: "open-project-settings", projectId, section: "project-host" });
                  }}
                >
                  Host settings
                </Button>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
