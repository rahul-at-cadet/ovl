-- Runs once, only on a brand-new Postgres volume (docker-entrypoint-
-- initdb.d convention). SuperTokens auto-creates its own internal
-- tables (recipe_user_tenants, etc.) on first connect — if it shared
-- POSTGRES_DB with this app's own drizzle-managed schema, drizzle-kit
-- push's introspection step scans every table in the database and
-- chokes on at least one of SuperTokens' own index definitions.
-- Keeping them in separate databases avoids that collision entirely.
CREATE DATABASE supertokens;
