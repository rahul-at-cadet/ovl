# Schema-per-tenant multi-tenancy

One Postgres database. One schema per tenant (`tenant_<slug>`). One shared
connection pool. A request can only ever reach the schema belonging to the
tenant its session maps to, and that is enforced by Postgres rather than by
application discipline.

## Why schema-per-tenant

Three models are usually on the table. AWS calls them silo (a database per
tenant), pool (one shared schema, a `tenant_id` column on every table), and
bridge (a schema per tenant in one database).

The pool model was rejected because it makes isolation a property of every
query ever written. One `WHERE tenant_id = ?` forgotten in one join, once, is
a cross-tenant read — and the query still returns rows, still passes review,
and still passes any test that runs with a single tenant loaded. Row-level
security narrows that, but it puts the guarantee behind a session variable that
must be set correctly on a pooled connection every single time.

The silo model was rejected on operations: a database per tenant multiplies
connection counts and turns every migration into an N-database orchestration
problem with no shared transaction.

Bridge sits in between, and its central advantage is that the isolation
boundary is an object Postgres already understands. A role that has no
privileges on `tenant_b` cannot read `tenant_b` — not "should not", cannot.

Its known weakness is that resource isolation does not come with it: every
tenant shares one pool, so a noisy tenant is everyone's problem unless
something caps them. `TenantConcurrencyService` is that cap.

## The four layers

No single mechanism is trusted. Each layer below is independently sufficient
to prevent a leak, so a bug has to defeat all four at once.

| # | Layer | Mechanism | Fails as |
|---|-------|-----------|----------|
| 1 | Resolution | Tenant derived from the SuperTokens session only, never a header or parameter | 403 |
| 2 | Propagation | `AsyncLocalStorage`, frozen context, no setter | Throws |
| 3 | Binding | `SET LOCAL search_path` per transaction | Wrong-schema query fails |
| 4 | Authorisation | `SET LOCAL ROLE` against a `NOINHERIT` login role | `permission denied for schema` |

Layer 4 is the one that actually matters. `ovl_api` — the role the pool logs in
as — is `NOINHERIT` and owns nothing. It is a member of every tenant role but
holds none of their privileges until a transaction explicitly assumes one. So a
request that fails to select a tenant does not get a default; it gets an error.

Layers 1–3 decide *which* schema a request should reach. Only layer 4 decides
which it *may* reach. Keep that distinction in mind when changing anything
here: weakening 1–3 causes bugs, weakening 4 causes breaches.

## The transaction preamble

Every tenant query runs inside this, in `TenantDbService`:

```sql
BEGIN;
SET LOCAL ROLE "tenant_acme_rw";
SET LOCAL search_path TO "tenant_acme";
SET LOCAL statement_timeout = 15000;
SELECT current_user, current_schema();   -- proof, not assumption
-- ... work ...
COMMIT;                                   -- both settings revert here
```

**`SET LOCAL`, never `SET`.** This is the single most important line in the
subsystem. A session-level `SET` survives `client.release()` and travels back
into the pool, so the next request to borrow that connection — very likely a
different tenant — inherits the previous tenant's role and schema. That is a
real cross-tenant read, and because it depends on connection reuse it appears
only under concurrent load, which is to say only in production. Transaction
scoped settings cannot outlive the transaction even if the process dies.

The trailing `SELECT` is there so a bind that silently did not apply becomes an
exception on this request rather than a query against whatever schema the
connection happened to be pointing at. The whole preamble is one multi-statement
query, so it costs one round trip.

If `ROLLBACK` ever fails, the connection is destroyed rather than returned to
the pool (`client.release(true)`). Its session state is unknown at that point,
and an unknown connection in a shared pool is exactly how state crosses
tenants. A reconnect is cheap; a leak is not.

## Connection pooling

**One pool per process, shared by all tenants.** This is deliberate and should
not be changed to a pool per tenant.

It is only possible because tenant selection is transaction-scoped: a
connection sitting idle in the pool belongs to no tenant, so the next request
can take it whoever it is for. A pool per tenant would multiply idle
connections by tenant count against a fixed `max_connections` — the documented
failure mode of this architecture, and the reason people abandon it at scale.

Budget the pool as `API instances × Node processes × max ≤ max_connections`,
with headroom for migrations and monitoring. Defaults live in
`packages/database/src/pool.ts`; the ones that matter:

- `connectionTimeoutMillis: 2000` — node-postgres defaults this to *wait
  forever*, which turns pool exhaustion into an unbounded queue of hanging
  requests. Always set it.
- `idle_in_transaction_session_timeout: 30000` — backstop for an abandoned
  transaction holding a connection and its tenant role.
- `maxLifetimeSeconds` / `maxUses` — rotate connections so a long-lived process
  cannot pin a bad backend indefinitely.

### Overload

Schema-per-tenant isolates data, not resources. `TenantConcurrencyService` caps
concurrent transactions per tenant (default: a third of the pool) and sheds
anything queued beyond `tenantQueueTimeoutMillis` with a 503.

Shedding rather than queueing is the point. A request that waits indefinitely
has consumed a socket and a slot and will return nothing useful even if it
eventually runs, and long queues widen the window in which every other
concurrency bug becomes reachable.

There is no worker thread pool here, and there should not be. Node's
concurrency for this workload is I/O-bound — the process is waiting on Postgres,
not computing — so `worker_threads` would add serialisation cost and complexity
for no throughput. The pool being reused *is* the reuse story. If a genuinely
CPU-bound task appears later (large CSV export, PDF rendering), give that task
its own worker pool and pass it a tenant id explicitly; do not put request
handling on workers, because `AsyncLocalStorage` does not cross the thread
boundary.

## Caching

Use `TenantCacheService`. Do not add ad-hoc `Map`s holding tenant data.

Caching is the leak path that survives every database-level defence. The
connection binding guarantees a *query* cannot cross tenants; it says nothing
about a result cached under a bare key like `vessels:all` and then served to
whoever asks next. `TenantCacheService` prepends the tenant id in one place so
no call site has to remember. The same applies to any Redis added later.

## Using it

```ts
@Injectable()
export class VesselsService {
  constructor(private readonly tenantDb: TenantDbService) {}

  async list() {
    return this.tenantDb.withTenant(
      (db) => db.select().from(schema.vessels),
      { readOnly: true },
    );
  }
}
```

`readOnly: true` on query paths is worth the keystrokes: an accidental write
then fails at the database instead of succeeding against the right schema.

Controllers:

```ts
@UseGuards(AuthGuard, TenantGuard)
@Get()
list(@CurrentTenant() tenant: TenantContext) { ... }
```

Background work — cron, queue consumers, migration fan-out — has no session, so
it must enter a context explicitly, one tenant at a time:

```ts
for (const tenant of await this.registry.list()) {
  await this.tenantDb.runFor(tenant, async (db) => { ... });
}
```

Never loop over tenants *inside* one context. `AsyncLocalStorage` follows async
resources, not closures: a callback defined inside a context but invoked later
from elsewhere gets no context and throws — which is the safe outcome, and the
reason the explicit form exists.

## Operating

```bash
./packages/database/bootstrap/generate-tenancy-credentials.sh
set -a && source .env.tenancy && set +a
psql "$SUPERUSER_DATABASE_URL" \
  -v api_password="$OVL_API_DB_PASSWORD" \
  -v admin_password="$OVL_ADMIN_DB_PASSWORD" \
  -f packages/database/bootstrap/platform-bootstrap.sql
```

Then, from `apps/api-office`:

```bash
npm run tenant:provision -- --name "Northstar Shipping"
npm run tenant:assign -- --user <supertokensUserId> --slug northstar_shipping
npm run tenant:list
npm run tenant:suspend -- --slug northstar_shipping
```

Provisioning requires `ADMIN_DATABASE_URL` and is **disabled in the serving API
process** unless one is configured. That is intentional: a bug on a request
path should not be able to manufacture privileges for itself.

Suspension takes effect within one registry cache TTL (30s default), or
immediately via `registry.invalidate()`.

## Enabling

Multi-tenancy is behind `MULTI_TENANCY_ENABLED=true`. Unset, the app runs
exactly as it did before against the single shared schema, so this code can
land and be reviewed without touching a running deployment.

Configuration lives in `.env.tenancy`; see `.env.tenancy.example` and the
**Roles and credentials** section below.

## Verification status

Verified against live PostgreSQL 16 (`ovl-local-pg`), with two real tenants
provisioned through the actual CLI:

| Check | Result |
|---|---|
| `ovl_api` role attributes | `rolinherit=f`, `rolsuper=f`, `rolcreaterole=f` |
| `ovl_admin` role attributes | `rolcreaterole=t`, `rolsuper=f` |
| Bootstrap idempotency | re-run clean; missing-password guard fires |
| Provisioning as non-superuser `ovl_admin` | 2 tenants, 29 tables each |
| Tenant FKs after `"public".` stripping | point at `tenant_<slug>.*`, not `public.*` |
| `ovl_api` with no role assumed | `permission denied for schema` |
| Assumed tenant A, reading tenant B | `permission denied for schema` |
| Assumed tenant A, reading tenant A | succeeds, correct `current_user`/`current_schema` |
| After `COMMIT` (the pool-reuse case) | back to bare `ovl_api`, empty `search_path`, access denied again |
| Two tenants with real rows | each sees only its own; cross-schema read denied |

The last two rows are the ones that matter. A released connection carries
nothing forward, and a tenant cannot reach another tenant's schema even by
naming it explicitly.

Unit tests: `npx jest src/tenancy` — 61 tests covering identifier validation
against injection, context propagation under interleaved concurrent requests,
the exact SQL preamble, connection release and destruction paths, per-tenant
concurrency limiting and shedding, and cache key scoping.

Two bugs that only surfaced by actually running this, both now fixed: psql does
not interpolate `:'variables'` inside dollar-quoted strings (so the bootstrap's
`CREATE ROLE ... PASSWORD` never received one — it uses `\gexec` now), and the
CLI printed results through a Nest log level it had itself disabled.

## Roles and credentials

Three roles, three privilege levels, and the split is the point:

| Role | Holds | Used by |
|---|---|---|
| `ovl_api` | `NOINHERIT`, owns nothing, `SELECT` on the registry | the serving API's pool |
| `ovl_admin` | `CREATEROLE` + `CREATE` on database, not superuser | the tenant CLI |
| superuser | everything | `platform-bootstrap.sql`, once |

The serving API can never create a schema or a role. Provisioning can never
read tenant data — it is not a member of any tenant role.

Generate local credentials with:

```bash
./packages/database/bootstrap/generate-tenancy-credentials.sh
```

That writes `.env.tenancy` (mode 600, gitignored by the existing `.env.*`
rule). `.env.tenancy.example` is the committed record of which variables exist.
The script refuses to overwrite an existing file, because those passwords are
already installed in a database and replacing them silently would leave the
file and the database disagreeing.

## Still to do

Landed here: the registry, provisioning, context, binding, pooling, admission
control and caching — the machinery. Not yet done:

1. **Migrate call sites.** Every service still injects the global
   `DATABASE_CONNECTION`. Each needs to move to `TenantDbService.withTenant`.
   Do it module by module; the two can coexist while
   `MULTI_TENANCY_ENABLED` is off.
2. **tRPC procedures.** Add `tenantProcedure = protectedProcedure.use(...)`
   asserting a context, and migrate procedures onto it. The middleware is
   already mounted ahead of the tRPC handler in `main.ts`.
3. ~~**Migration fan-out.**~~ Done — see **Migrations** below.
4. **Data backfill.** Move the existing single-tenant `public` data into the
   first tenant schema.
5. **A cross-tenant integration test.** Two real tenants, concurrent
   interleaved requests, asserting neither sees the other's rows. This is the
   test that would actually catch a regression in layer 4.
6. **Per-tenant metrics.** Tag pool saturation and shed counts by tenant, so a
   noisy neighbour is visible before it is reported.

## Migrations

Tenant schema changes are ordered SQL in
`packages/database/tenant-migrations/`, applied by
`TenantMigrationRunnerService`.

```bash
npm run tenant:migrate:status --workspace api-office
npm run tenant:migrate --workspace api-office
```

A new tenant is built from `bootstrap/fresh-database.sql` **plus every
migration**, then has the whole set recorded as applied. An existing tenant
gets only what it is missing. Both paths converge on the same shape, so a
change is written once — as a migration — rather than twice, once in the
template and once as a migration, which is exactly how the two drift apart.

Three properties worth keeping:

- **Each tenant is its own transaction**, and the DDL and the ledger row commit
  together. A run that dies on tenant 40 of 200 leaves 39 correctly migrated
  and is resumed, not restarted — and no tenant can end up migrated without
  that fact being recorded, or vice versa.
- **A failure does not stop the fleet.** One tenant with a wedged lock should
  not block the other 199; failures come back in the result and the run is safe
  to repeat.
- **An applied migration must never be edited.** The runner checksums every
  file and refuses to proceed if one a tenant has already applied has changed,
  because from that point the ledger is describing a schema that does not
  exist. Add a new migration.

Because the fan-out is not atomic *across* tenants, a failed run leaves the
fleet on mixed versions — each internally consistent. Prefer additive
migrations, so a partially-migrated fleet keeps working.

## Extension points

- **Users in several tenants.** Do *not* relax `platform.tenant_users`'s
  primary key and pick the first row — ambiguous resolution is the hole this
  design closes. Add a separate `tenant_memberships` table and keep
  `tenant_users` as the unambiguous active-tenant pointer, switched only by an
  explicit audited action.
- **Sharding across databases.** Add a `database_url` column to
  `platform.tenants` and have `TenantDbService` select a pool per tenant. The
  descriptor already carries everything the binding needs.
- **Redis.** Prefix keys with the tenant id inside `TenantCacheService` so it
  stays the single place scoping is applied.
