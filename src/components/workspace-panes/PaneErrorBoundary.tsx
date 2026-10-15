import type { ReactNode } from "react";
import { ErrorBoundary } from "../ui/ErrorBoundary/ErrorBoundary";
import { FallbackScreen } from "../ui/ErrorBoundary/FallbackScreen";
import { Button } from "../ui/Button/Button";
import { ipcErrorMessage } from "../../lib/ipc-error";

/**
 * One pane's render error stays in that pane (ADR-232 D3): its siblings, the
 * tab bar and the sidebar keep working, and "Reload pane" remounts it.
 */
export function PaneErrorBoundary(props: { paneId: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      label={`pane ${props.paneId}`}
      fallback={(error, reset) => (
        <FallbackScreen
          data-testid="pane-crashed"
          title="This pane crashed"
          message={ipcErrorMessage(error)}
          actions={
            <Button variant="primary" size="sm" onClick={reset}>
              Reload pane
            </Button>
          }
        />
      )}
    >
      {props.children}
    </ErrorBoundary>
  );
}
