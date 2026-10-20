import React from "react";

type GapSize = "2xs" | "xxs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl";

interface LayoutProps {
  gap?: GapSize;
  align?: React.CSSProperties["alignItems"];
  justify?: React.CSSProperties["justifyContent"];
  className?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}

const gapScale: Record<GapSize, number> = {
  "2xs": 2,
  xxs: 6,
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
    const { gap, align, justify, className, children, "data-testid": dataTestId } = props;

    const style: React.CSSProperties = {
      display: "flex",
      flexDirection: "column",
      ...(gap !== undefined ? { gap: gapScale[gap] } : {}),
      ...(align !== undefined ? { alignItems: align } : {}),
      ...(justify !== undefined ? { justifyContent: justify } : {}),
    };

    return (
      <div ref={ref} style={style} className={className} data-testid={dataTestId}>
        {children}
      </div>
    );
  }
);

Stack.displayName = "Stack";

export const Row = React.forwardRef<HTMLDivElement, LayoutProps>(
  function Row(props, ref) {
    const { gap, align, justify, className, children, "data-testid": dataTestId } = props;

    const style: React.CSSProperties = {
      display: "flex",
      flexDirection: "row",
      ...(gap !== undefined ? { gap: gapScale[gap] } : {}),
      ...(align !== undefined ? { alignItems: align } : {}),
      ...(justify !== undefined ? { justifyContent: justify } : {}),
    };

    return (
      <div ref={ref} style={style} className={className} data-testid={dataTestId}>
        {children}
      </div>
    );
  }
);

Row.displayName = "Row";
