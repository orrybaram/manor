import { lazy, Suspense, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary } from "./components/ui/ErrorBoundary/ErrorBoundary";
import { FallbackScreen } from "./components/ui/ErrorBoundary/FallbackScreen";
import { Button } from "./components/ui/Button/Button";
import { ipcErrorMessage } from "./lib/ipc-error";

/**
 * What `main.tsx` and `web-main.tsx` render identically (ADR-182 D11): the
 * `QueryClient` options and the `<App/>` tree. Only how each entry gets
 * there — the preload's bridge vs. a paired token — differs, so that stays
 * in the two files rather than moving here.
 */
// eslint-disable-next-line react-refresh/only-export-components -- shared with AppRoot below, see the module comment
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 2, // 2 minutes
        gcTime: 1000 * 60 * 10, // 10 minutes
        refetchOnWindowFocus: false,
      },
    },
  });
}

// One renderer for every window (ADR-179 D4). A detached window is not a
// different app: it is `App` with a claim on one tab of the shared layout.
// Loaded lazily so a splash can paint while its chunk graph loads. (The entry
// modules are never hot-swapped, so fast refresh has nothing to preserve.)
const App = lazy(() => import("./App"));

export function AppRoot(props: {
  queryClient: QueryClient;
  /** What shows while `App` itself loads. */
  fallback?: ReactNode;
}) {
  return (
    <QueryClientProvider client={props.queryClient}>
      {/* Every window — a detached one included — is this `App`, so one
          boundary covers them all (ADR-232 D3). */}
      <ErrorBoundary
        label="app"
        fallback={(error) => (
          <FallbackScreen
            fullWindow
            data-testid="app-crashed"
            title="Manor hit an unexpected error"
            message={ipcErrorMessage(error)}
            actions={
              <Button variant="primary" onClick={() => window.location.reload()}>
                Reload window
              </Button>
            }
          />
        )}
      >
        <Suspense fallback={props.fallback ?? null}>
          <App />
        </Suspense>
      </ErrorBoundary>
    </QueryClientProvider>
  );
}
