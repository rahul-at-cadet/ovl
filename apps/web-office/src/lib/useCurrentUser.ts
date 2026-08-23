import { useQuery } from '@tanstack/react-query';
import { API_ORIGIN } from '@/lib/api-origin';

export interface CurrentUser {
  id: string;
  username: string;
  roles: string[];
  active: boolean;
  mustChangePassword: boolean;
}

// GET /users/me is a plain REST endpoint (api-office/src/users/users.controller.ts),
// not tRPC — the SuperTokens frontend SDK patches global fetch to attach the
// session's access-token header automatically, same as it does for the tRPC
// client's requests, so no extra auth wiring is needed here.
export function useCurrentUser() {
  return useQuery<CurrentUser>({
    queryKey: ['currentUser'],
    queryFn: async () => {
      const res = await fetch(`${API_ORIGIN}/users/me`);
      if (!res.ok) throw new Error('Failed to load current user');
      return res.json();
    },
  });
}
