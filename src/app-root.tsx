import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";

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

export function AppRoot(props: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={props.queryClient}>
      <App />
    </QueryClientProvider>
  );
}
