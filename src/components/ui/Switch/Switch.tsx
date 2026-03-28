import * as SwitchPrimitive from "@radix-ui/react-switch";
import { type ComponentPropsWithoutRef } from "react";
import styles from "./Switch.module.css";

type SwitchProps = ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>;

export function Switch(props: SwitchProps) {
  const { className, ...rest } = props;

  return (
    <SwitchPrimitive.Root
      className={`${styles.root}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <SwitchPrimitive.Thumb className={styles.thumb} />
    </SwitchPrimitive.Root>
  );
}
