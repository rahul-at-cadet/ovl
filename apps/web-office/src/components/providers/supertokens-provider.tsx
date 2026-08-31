'use client';

import React from 'react';
import SuperTokens, { SuperTokensWrapper } from 'supertokens-auth-react';
import EmailPassword from 'supertokens-auth-react/recipe/emailpassword';
import Session from 'supertokens-auth-react/recipe/session';
import { REQUEST_TIMEOUT_MS, timeoutSignal } from '@/lib/request-timeout';

if (typeof window !== 'undefined') {
  // Local dev serves web-office and api-office on separate ports/origins.
  // In a Docker/nginx deployment they're one public origin with nginx
  // routing by path, so both domains are just wherever the page loaded
  // from — window.location.origin, not a baked-in hostname (the real
  // domain isn't known at build time and shouldn't need to be).
  const isProd = process.env.NODE_ENV === 'production';
  const origin = window.location.origin;
  SuperTokens.init({
    appInfo: {
      appName: 'SPARKS',
      apiDomain: isProd ? origin : 'http://localhost:3001',
      websiteDomain: isProd ? origin : 'http://localhost:3000',
      apiBasePath: '/auth',
      websiteBasePath: '/login',
    },
    recipeList: [
      EmailPassword.init(),
      Session.init({
        /*
         * A deadline on SuperTokens' own network calls — which, for the
         * session recipe, means the token refresh.
         *
         * This is the fix for the app hanging on "Checking session..."
         * indefinitely. Refresh is not an ordinary request that a caller can
         * shrug off: `doesSessionExist()` awaits it, AppShell awaits that, and
         * the entire screen is behind it. The SDK handles a refresh that
         * *fails* — it returns API_ERROR and the session resolves as absent,
         * which sends the visitor to the login page. What it has no answer for
         * is a refresh that never comes back at all, because `fetch` has no
         * timeout: the promise stays pending, so there is no error to handle
         * and nothing downstream ever runs. A server that accepts the
         * connection and then goes quiet — restarting, saturated, or behind a
         * proxy that lost its upstream — produces exactly that, and it is why
         * the hang was intermittent rather than reproducible.
         *
         * Aborting converts that case into the failing case the SDK already
         * knows how to handle, so the visitor lands on the login page instead
         * of a screen that never changes.
         *
         * requestInit is spread rather than mutated: it belongs to the SDK,
         * and this hook is documented as returning the request to send, not as
         * a licence to edit theirs in place.
         */
        preAPIHook: async ({ url, requestInit }) => ({
          url,
          requestInit: {
            ...requestInit,
            signal: timeoutSignal(REQUEST_TIMEOUT_MS, requestInit.signal),
          },
        }),
      }),
    ],
  });
}

export function SuperTokensProvider({ children }: { children: React.ReactNode }) {
  return <SuperTokensWrapper>{children}</SuperTokensWrapper>;
}
