#!/usr/bin/env bash
#
# Generates .env.tenancy with fresh random passwords for the two tenancy roles.
#
# Refuses to overwrite an existing file: the passwords in it are already
# installed in a database, and silently replacing them would leave the file and
# the database disagreeing — which surfaces later as an authentication failure
# with no obvious cause. Delete it deliberately, or pass --force, and re-run
# platform-bootstrap.sql afterwards so the database gets the new passwords too.
#
# Usage:
#   ./packages/database/bootstrap/generate-tenancy-credentials.sh [--force]
#                                                                [--db ovl_office]
#                                                                [--host localhost]
#                                                                [--port 5432]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
target="${repo_root}/.env.tenancy"

force=0
db=ovl_office
host=localhost
port=5432

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) force=1; shift ;;
    --db)    db="$2";   shift 2 ;;
    --host)  host="$2"; shift 2 ;;
    --port)  port="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -f "$target" && $force -eq 0 ]]; then
  echo "Refusing to overwrite ${target} (pass --force to replace it)." >&2
  echo "Those passwords are already installed in a database; replacing them" >&2
  echo "means re-running platform-bootstrap.sql to match." >&2
  exit 1
fi

# openssl rather than $RANDOM: these are real credentials, and $RANDOM is not a
# cryptographic source. Base64 is trimmed to an alphanumeric alphabet so the
# password can sit in a connection URL without percent-encoding.
gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
}

api_password="$(gen_password)"
admin_password="$(gen_password)"

umask 077
cat > "$target" <<EOF
# Local development credentials for schema-per-tenant multi-tenancy.
#
# GITIGNORED (matched by .env.* in .gitignore) — real secrets, never committed.
# The committed template is .env.tenancy.example.
#
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by generate-tenancy-credentials.sh
#
# Install these roles into the database (needs a superuser, once):
#   set -a && source .env.tenancy && set +a
#   psql "\$SUPERUSER_DATABASE_URL" \\
#     -v api_password="\$OVL_API_DB_PASSWORD" \\
#     -v admin_password="\$OVL_ADMIN_DB_PASSWORD" \\
#     -f packages/database/bootstrap/platform-bootstrap.sql

MULTI_TENANCY_ENABLED=true

# ovl_api — the serving API's pool. NOINHERIT, owns nothing, can only read the
# tenant registry until a transaction assumes a tenant role.
OVL_API_DB_USER=ovl_api
OVL_API_DB_PASSWORD=${api_password}
DATABASE_URL=postgresql://ovl_api:${api_password}@${host}:${port}/${db}

# ovl_admin — provisioning only (CREATEROLE + CREATE on database, NOT superuser).
# Used by the tenant CLI. Leave ADMIN_DATABASE_URL unset in the serving API so
# provisioning is disabled there.
OVL_ADMIN_DB_USER=ovl_admin
OVL_ADMIN_DB_PASSWORD=${admin_password}
ADMIN_DATABASE_URL=postgresql://ovl_admin:${admin_password}@${host}:${port}/${db}

# Superuser — bootstrap only. Not used by the application at runtime.
SUPERUSER_DATABASE_URL=postgresql://ovl:ovl@${host}:${port}/${db}

PG_POOL_MAX=15
EOF

chmod 600 "$target"
echo "Wrote ${target} (mode 600, gitignored)."
echo "Next: run platform-bootstrap.sql so the database gets these passwords."
