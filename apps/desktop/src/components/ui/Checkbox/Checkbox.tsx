import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import Check from "lucide-react/dist/esm/icons/check";
import { type ComponentPropsWithoutRef } from "react";
import styles from "./Checkbox.module.css";

const iconSizes = { sm: 8, md: 10, lg: 12 } as const;

type CheckboxProps = ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root> & {
  size?: "sm" | "md" | "lg";
};

export function Checkbox({ size = "sm", className, ...rest }: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      className={`${styles.checkbox} ${styles[size]}${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className={styles.icon}>
        <Check size={iconSizes[size]} strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
