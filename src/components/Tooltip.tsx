import * as RadixTooltip from "@radix-ui/react-tooltip";
import styles from "./Tooltip.module.css";

interface TooltipProps {
  label: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  delayDuration?: number;
}

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={400}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({
  label,
  children,
  side = "bottom",
  delayDuration,
}: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
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
