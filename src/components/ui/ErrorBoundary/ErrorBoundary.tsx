import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  /** What renders in place of `children` once they throw. `reset` remounts them. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Where the boundary is, for the console line it logs. */
  label: string;
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  /** Bumped on reset, so the children remount fresh rather than re-rendering. */
  generation: number;
};

/**
 * Catch a render error below this point and show `fallback` instead of
 * letting it unmount the whole tree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, generation: 0 };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[${this.props.label}] render error:`, error, info.componentStack);
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, generation: s.generation + 1 }));
  };

  render(): ReactNode {
    const { error, generation } = this.state;
    if (error) return this.props.fallback(error, this.reset);
    return <ErrorBoundaryChildren key={generation}>{this.props.children}</ErrorBoundaryChildren>;
  }
}

/** A keyed wrapper: changing its key remounts everything below it. */
function ErrorBoundaryChildren(props: { children: ReactNode }) {
  return <>{props.children}</>;
}
