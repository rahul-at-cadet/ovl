'use client';

import React from 'react';
import SuperTokens, { SuperTokensWrapper } from 'supertokens-auth-react';
import EmailPassword from 'supertokens-auth-react/recipe/emailpassword';
import Session from 'supertokens-auth-react/recipe/session';

if (typeof window !== 'undefined') {
  SuperTokens.init({
    appInfo: {
      appName: 'OVL Office',
      apiDomain: 'http://localhost:3001',
      websiteDomain: 'http://localhost:3000',
      apiBasePath: '/auth',
      websiteBasePath: '/login',
    },
    recipeList: [EmailPassword.init(), Session.init()],
  });
}

export function SuperTokensProvider({ children }: { children: React.ReactNode }) {
  return <SuperTokensWrapper>{children}</SuperTokensWrapper>;
}
