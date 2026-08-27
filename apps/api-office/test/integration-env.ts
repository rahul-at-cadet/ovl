/**
 * Maps the integration-test connection strings into the variables AppModule
 * reads, before anything imports it.
 *
 * This has to be a jest `setupFiles` entry rather than a line in the spec:
 * `app.module.ts` decides whether to register TenancyModule at module scope,
 * when the file is first required. By the time `beforeAll` runs, that decision
 * is already made and the pool is already pointed at whatever DATABASE_URL
 * said — which, thanks to the root .env, is the real development database.
 *
 * A no-op unless the integration variables are set, so unit tests are
 * unaffected.
 */
if (process.env.TENANCY_TEST_DATABASE_URL && process.env.TENANCY_TEST_ADMIN_DATABASE_URL) {
  process.env.MULTI_TENANCY_ENABLED = 'true';
  process.env.DATABASE_URL = process.env.TENANCY_TEST_DATABASE_URL;
  process.env.ADMIN_DATABASE_URL = process.env.TENANCY_TEST_ADMIN_DATABASE_URL;
}
