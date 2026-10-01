import { useRef, useState, type PointerEvent, type ReactElement } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
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

/** Hover intent: a pass over the trigger doesn't flash the popover open. */
const OPEN_DELAY_MS = 150;
/** Grace to cross the gap from the trigger into the popover. */
const CLOSE_DELAY_MS = 200;

/**
 * What a host chip or icon opens, on hover or click: the host's state in
 * plain words, Retry, and a way to its settings. The chip itself only names
 * the host.
 */
export function HostPopover(props: HostPopoverProps) {
  const { hostId, projectId, side = "top", children } = props;

  const display = useHostDisplay(hostId);
  const [open, setOpen] = useState(false);
  // Opened by hover: don't pull focus into the popover (a focus ring on its
  // first control reads as a selection the user never made).
  const hoverOpened = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useMountEffect(() => clearTimer);

  const hoverOpen = () => {
    clearTimer();
    if (open) return;
    timer.current = setTimeout(() => {
      hoverOpened.current = true;
      setOpen(true);
    }, OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    clearTimer();
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const hoverHandlers = {
    onPointerEnter: (e: PointerEvent) => {
      if (e.pointerType === "mouse") hoverOpen();
    },
    onPointerLeave: (e: PointerEvent) => {
      if (e.pointerType === "mouse" && hoverOpened.current) hoverClose();
    },
  };

  if (!display) return children;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        clearTimer();
        // A click while hover-opened pins it: it no longer closes on leave.
        hoverOpened.current = false;
        setOpen(next);
      }}
    >
      <Popover.Trigger
        asChild
        {...hoverHandlers}
        onClick={(e) => {
          // A click on a hover-opened popover pins it rather than closing it.
          if (open && hoverOpened.current) {
            e.preventDefault();
            clearTimer();
            hoverOpened.current = false;
          }
        }}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className={styles.popover}
          side={side}
          align={side === "top" || side === "bottom" ? "end" : "start"}
          sideOffset={6}
          collisionPadding={8}
          data-testid="host-popover"
          {...hoverHandlers}
          onOpenAutoFocus={(e) => {
            if (hoverOpened.current) e.preventDefault();
          }}
          // Portal content still bubbles React events to the row it sits in,
          // which toggles or selects on click.
          onPointerDown={(e) => {
            e.stopPropagation();
            // Interacting with it pins it open.
            clearTimer();
            hoverOpened.current = false;
          }}
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
