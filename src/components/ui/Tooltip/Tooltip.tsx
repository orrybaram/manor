import * as RadixTooltip from "@radix-ui/react-tooltip";
import styles from "./Tooltip.module.css";

/**
 * Whether the last input was a pointer rather than a key. Radix opens a
 * tooltip whenever its trigger takes focus, including when a menu or popover
 * closes and hands focus back — so after picking from a menu with the mouse
 * the trigger's tooltip would pop up and stay. Focus only opens a tooltip
 * after keyboard input; hover still opens it as usual.
 */
let lastInputWasPointer = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    () => {
      lastInputWasPointer = true;
    },
    true,
  );
  window.addEventListener(
    "keydown",
    () => {
      lastInputWasPointer = false;
    },
    true,
  );
}

function skipPointerFocus(e: React.FocusEvent): void {
  // Radix's own focus handler is skipped for a default-prevented event.
  if (lastInputWasPointer) e.preventDefault();
}

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}

type TooltipProviderProps = {
  children: React.ReactNode;
};

export function TooltipProvider(props: TooltipProviderProps) {
  const { children } = props;

  return (
    <RadixTooltip.Provider delayDuration={400}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip(props: TooltipProps) {
  const { label, children, side = "bottom", delayDuration } = props;

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild onFocus={skipPointerFocus}>
        {children}
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className={styles.content}
          side={side}
          sideOffset={4}
        >
          {label}
          <RadixTooltip.Arrow className={styles.arrow} width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
