'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import React, { useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { API_ORIGIN } from '@/lib/api-origin';
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
