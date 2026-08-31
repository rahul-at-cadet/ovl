'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import React, { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';
import { REQUEST_TIMEOUT_MS, timeoutSignal } from '@/lib/request-timeout';
import { useToastManager } from '@ovl/ui/components/toast';
import { mutationErrorToast, type MutationMeta } from '@ovl/ui/lib/mutation-errors';

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const toastManager = useToastManager();
  // The QueryClient is built once and outlives every render, so it can't
  // close over `toastManager` directly — a ref keeps the cache handler
  // pointed at the current manager without rebuilding the client.
  const toastRef = useRef(toastManager);
  toastRef.current = toastManager;

  const [queryClient] = useState(
    () =>
      new QueryClient({
        /*
         * Every failed mutation surfaces, without each call site having to
         * remember. Before this, 20 files called useMutation and there were
         * 18 onError handlers between them, so deleting a user or saving a
         * config bundle could fail with nothing shown at all.
         *
         * A mutation that renders its own error inline opts out with
         * `meta: { silentError: true }`; one that wants a specific headline
         * sets `meta: { errorTitle: '...' }`.
         */
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            const meta = mutation.options.meta as MutationMeta | undefined;
            if (meta?.silentError) return;
            toastRef.current.add(mutationErrorToast(error, meta));
          },
        }),
      }),
  );

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${API_ORIGIN}/trpc`,
          /*
           * Every tRPC request gets a deadline.
           *
           * `fetch` waits forever by default, so an API that accepts the
           * connection and then never answers leaves the query permanently
           * `isLoading` — not failed, just pending. Any screen gated on one is
           * then stuck with nothing to render and no error to show; the login
           * page sat on "Checking setup status..." exactly this way, which
           * also made it useless as the fallback for a failed session check.
           *
           * React Query's `retry` does not help here, because retries are for
           * requests that finish badly, and this one does not finish at all.
           * Aborting gives it something to retry, and then to report.
           *
           * tRPC passes its own signal for cancellation on unmount, so it is
           * forwarded rather than replaced — see timeoutSignal.
           */
          fetch: (url, options) =>
            fetch(url, {
              ...options,
              signal: timeoutSignal(REQUEST_TIMEOUT_MS, options?.signal),
            }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
