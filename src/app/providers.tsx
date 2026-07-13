'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser session — useState keeps it stable across
  // re-renders and Fast Refresh without sharing state between SSR requests.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Explicit rather than relying on the browser default of 3:
            // fetchQuery/prefetchQuery treat an unset retry as false, and the
            // initial page load and adjacent-year prefetches go through them.
            retry: 3,
            // Refocusing the tab must never rebuild every facility's canvas
            // tiles; freshness is handled by per-year staleTime instead
            // (see yearQueryOptions).
            refetchOnWindowFocus: false,
            // Unobserved queries are garbage-collected after a day. No
            // LRU-style cap is needed: the domain tops out at ~21 years
            // (2006 → current), a few MB of canvas each.
            gcTime: 24 * 60 * 60 * 1000,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
