# Tenant schema migrations

Ordered SQL applied inside every tenant schema, newest last. Filenames are
`NNNN_description.sql` and the numeric prefix is the version recorded in
`platform.tenant_migrations`.

## Why these are separate from `bootstrap/fresh-database.sql`

They are not. That is the point.

A new tenant gets `fresh-database.sql` and then *every* migration in this
directory, in order. An existing tenant gets only the migrations it has not
recorded yet. Both paths converge on the same shape, so a change is written
once here rather than twice — once in the template for new tenants and once as
a migration for existing ones, which is how the two drift apart.

## Rules

- **Never edit an applied file.** The runner checksums each one and refuses to
  proceed if a file that a tenant has already applied has changed, because the
  recorded state would no longer describe the schema. Add a new migration.
- **Write them unqualified.** They run with `search_path` set to the tenant
  schema and the tenant role assumed, so a bare `CREATE TABLE` lands in the
  right place and is owned by the right role. Never write `public.` — that is
  a cross-schema reference into somebody else's data.
- **Prefer additive changes.** The fan-out is not atomic across tenants: each
  tenant is its own transaction, so a run can succeed for some and fail for
  others. A migration that only adds things leaves a partially-migrated fleet
  working; one that renames or drops does not.
