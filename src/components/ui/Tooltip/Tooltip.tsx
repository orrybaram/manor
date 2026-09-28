import * as RadixTooltip from "@radix-ui/react-tooltip";
import styles from "./Tooltip.module.css";

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
  /** Keeps the tooltip closed, e.g. while a popover on the same trigger is open. */
  disabled?: boolean;
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
  const { label, children, side = "bottom", delayDuration, disabled = false } = props;

  return (
    <RadixTooltip.Root delayDuration={delayDuration} open={disabled ? false : undefined}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.content} side={side} sideOffset={4}>
          {label}
          <RadixTooltip.Arrow className={styles.arrow} width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
