'use client';

import React from 'react';
import SuperTokens, { SuperTokensWrapper } from 'supertokens-auth-react';
import EmailPassword from 'supertokens-auth-react/recipe/emailpassword';
import Session from 'supertokens-auth-react/recipe/session';

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
      appName: 'Cadetlabs',
      apiDomain: isProd ? origin : 'http://localhost:3001',
      websiteDomain: isProd ? origin : 'http://localhost:3000',
      apiBasePath: '/auth',
      websiteBasePath: '/login',
    },
    recipeList: [EmailPassword.init(), Session.init()],
  });
}

export function SuperTokensProvider({ children }: { children: React.ReactNode }) {
  return <SuperTokensWrapper>{children}</SuperTokensWrapper>;
}
