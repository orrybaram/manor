import React from "react";

type GapSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

interface LayoutProps {
  gap?: GapSize;
  align?: React.CSSProperties["alignItems"];
  justify?: React.CSSProperties["justifyContent"];
  className?: string;
  children: React.ReactNode;
}

const gapScale: Record<GapSize, number> = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
};

export const Stack = React.forwardRef<HTMLDivElement, LayoutProps>(
  function Stack(props, ref) {
    const { gap, align, justify, className, children } = props;

    const style: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      ...(gap !== undefined ? { gap: gapScale[gap] } : {}),
      ...(align !== undefined ? { alignItems: align } : {}),
      ...(justify !== undefined ? { justifyContent: justify } : {}),
    };

    return (
      <div ref={ref} style={style} className={className}>
        {children}
      </div>
    );
  }
);

Stack.displayName = "Stack";

export const Row = React.forwardRef<HTMLDivElement, LayoutProps>(
  function Row(props, ref) {
    const { gap, align, justify, className, children } = props;

    const style: React.CSSProperties = {
      display: "flex",
      flexDirection: "row",
      ...(gap !== undefined ? { gap: gapScale[gap] } : {}),
      ...(align !== undefined ? { alignItems: align } : {}),
      ...(justify !== undefined ? { justifyContent: justify } : {}),
    };

    return (
      <div ref={ref} style={style} className={className}>
        {children}
      </div>
    );
  }
);

Row.displayName = "Row";
