import { useCurrentUser } from '@/lib/useCurrentUser';

/**
 * Whether this account may author fleet configuration.
 *
 * Every write on the Fleet Configuration page — publishing a schema, saving
 * a field policy, publishing or assigning a config bundle, editing a
 * compliance profile — is gated server-side by assertConfigManager
 * (api-office/src/rpc/trpc.router.ts), which requires the literal
 * `configManager` role.
 *
 * Roles in this system are additive, not hierarchical: `admin` grants the
 * destructive and credential-bearing procedures and nothing else, so an
 * admin-only account cannot author configuration. That is the intended
 * separation of duties, but the page used to render every control as
 * editable regardless and only surfaced the refusal as a toast on submit —
 * after the user had picked a scope, changed 400 fields and hit Save. The
 * commercial and reports pages already check their own role up front
 * (`commercialEditor`, `reviewer`); this is the check the configuration
 * page was missing.
 *
 * `undefined` means "not known yet" — still loading, or /users/me itself
 * failed. Callers must treat that as distinct from `false`: telling someone
 * they lack a role when the truth is the lookup broke sends them to an
 * administrator for a role they already have. Unknown therefore leaves the
 * controls alone and lets the server have the final say, which is exactly
 * the behaviour before this check existed.
 */
export function useCanAuthorConfig(): boolean | undefined {
  const { data, isPending, isError } = useCurrentUser();
  if (isPending || isError || !data) return undefined;
  return (data.roles ?? []).includes('configManager');
}

/**
 * The `title` on each control the role gate disables. A greyed-out button
 * with no explanation is its own small mystery, and hover is where someone
 * looks first.
 */
export const CONFIG_ROLE_HINT = 'Requires the Config Manager role';
