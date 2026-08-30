import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The active tenant, carried per request on the async execution path.
 *
 * AsyncLocalStorage rather than a REQUEST-scoped provider: request scope makes
 * Nest instantiate every provider in the injection chain per request, which is
 * a real throughput cost on a hot API, while ALS measures in the low single
 * digits of percent. NestJS's own async-context recipe recommends exactly this
 * trade.
 *
 * Read this carefully, because it is the most commonly misunderstood part of
 * the design: ALS is *routing*, not enforcement. It decides which schema a
 * request should reach. It does not, and cannot, stop a request reaching the
 * wrong one — that job belongs to Postgres (`SET LOCAL ROLE` against a
 * NOINHERIT login role, see TenantDbService). If ALS were the only defence,
 * every future bug in async propagation would be a data leak instead of an
 * error.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly slug: string;
  /** Validated against TENANT_SCHEMA_PATTERN before it is ever used in SQL. */
  readonly schemaName: string;
  /** Validated against TENANT_ROLE_PATTERN before it is ever used in SQL. */
  readonly roleName: string;
  /** Correlates log lines for one request. Not used for authorisation. */
  readonly requestId: string;
  /**
   * Forces every transaction on this request to be read-only.
   *
   * Set when a platform super admin is viewing a tenant in read mode. It lives
   * on the context rather than being passed per call because it must hold for
   * the whole request: a single service that forgot to ask for it would
   * otherwise be the one write that gets through. TenantDbService ORs it with
   * the per-call option, so a caller can add read-only but never remove it.
   */
  readonly readOnly?: boolean;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Whether the current request is pinned to read-only.
 *
 * Returns false outside a tenant context: work with no request behind it —
 * migrations, the provisioning CLI, scheduled jobs — is not a super admin
 * looking at a customer's data, and must not be silently made read-only.
 */
export function currentTenantReadOnly(): boolean {
  return storage.getStore()?.readOnly === true;
}

/**
 * Runs `fn` with `context` visible to everything it awaits.
 *
 * The context is frozen, and there is deliberately no setter: a context that
 * can be mutated mid-request is a context that can be mutated by request B
 * while request A is suspended at an await, which is the single most common
 * source of cross-tenant bugs that only appear under concurrency.
 */
export const runWithTenant = <T>(context: TenantContext, fn: () => T): T =>
  storage.run(Object.freeze({ ...context }), fn);

/**
 * The active tenant, or `undefined` outside a tenant-scoped path.
 *
 * Use this only where "no tenant" is genuinely valid — logging, metrics, the
 * middleware itself. Anything that touches tenant data must use
 * `currentTenant()` so that a missing context is an error.
 */
export const tryCurrentTenant = (): TenantContext | undefined => storage.getStore();

export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'No tenant context on this async execution path. Tenant-scoped work must run ' +
        'inside runWithTenant() — see apps/api-office/src/tenancy/README.md.',
    );
    this.name = 'MissingTenantContextError';
  }
}

/**
 * The active tenant, throwing if there is none.
 *
 * Throwing rather than returning a default is the whole contract. If the async
 * chain is broken — a listener registered at startup, a callback parked in a
 * queue and drained later, a promise created in one request and awaited in
 * another — this fails loudly on the spot instead of quietly falling back to
 * some other tenant's schema.
 */
export function currentTenant(): TenantContext {
  const context = storage.getStore();
  if (!context) throw new MissingTenantContextError();
  return context;
}

/**
 * Escape hatch for work that has no request behind it: scheduled jobs,
 * migration fan-out, queue consumers, CLI commands.
 *
 * Such work must enter a tenant context *explicitly and one tenant at a time*
 * rather than looping over tenants inside a single context. Named distinctly
 * from `runWithTenant` so that a grep for background tenant access finds it.
 */
export const runAsSystemForTenant = runWithTenant;

/**
 * Test-only view of the storage, so specs can assert propagation behaviour
 * without exporting the AsyncLocalStorage itself (which would let production
 * code call `.enterWith()` and set a context that never gets cleaned up).
 */
export const __testing = { storage };
