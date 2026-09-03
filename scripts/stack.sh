#!/usr/bin/env bash
#
# Build and run the ovl-node stack, all of it or a chosen subset.
#
# Written because the useful thing is almost never "rebuild everything":
# it is "rebuild the one service I just changed and bring it back up".
# Doing that by hand means remembering which compose file, which env
# file, and that build and up are two commands — easy to get half right,
# and a half-right deploy is worse than none.
#
#   ./scripts/stack.sh                          # ask what to build, then run it
#   ./scripts/stack.sh --all                    # every service, no prompting
#   ./scripts/stack.sh api-office web-office    # just these two
#   ./scripts/stack.sh --all --env-file .env.prod
#   ./scripts/stack.sh --build-only api-vessel  # build, do not start
#   ./scripts/stack.sh --no-build api-vessel    # start what is already built
#
# The env file is required and never guessed at: these compose files
# carry database credentials, and starting a stack against the wrong
# database is exactly the mistake worth making impossible.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Defaults chosen for the deployment case, since that is when a mistake
# costs something. Override either with a flag.
COMPOSE_FILE="docker-compose.azure.yml"
ENV_FILE=""
DO_BUILD=1
DO_RUN=1
ASSUME_ALL=0
SELECTED=()

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok() { printf '\033[32m  ✓\033[0m %s\n' "$*"; }

usage() {
  sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage ;;
    --all) ASSUME_ALL=1; shift ;;
    --env-file) ENV_FILE="${2:-}"; [[ -n "$ENV_FILE" ]] || die "--env-file needs a path"; shift 2 ;;
    --env-file=*) ENV_FILE="${1#*=}"; shift ;;
    -f|--file) COMPOSE_FILE="${2:-}"; [[ -n "$COMPOSE_FILE" ]] || die "--file needs a path"; shift 2 ;;
    --file=*) COMPOSE_FILE="${1#*=}"; shift ;;
    --build-only) DO_RUN=0; shift ;;
    --no-build) DO_BUILD=0; shift ;;
    -*) die "unknown option: $1  (try --help)" ;;
    *) SELECTED+=("$1"); shift ;;
  esac
done

command -v docker >/dev/null || die "docker is not on PATH"
docker info >/dev/null 2>&1 || die "the docker daemon is not running"
docker compose version >/dev/null 2>&1 || die "this needs the docker compose plugin (v2)"
[[ -f "$COMPOSE_FILE" ]] || die "no such compose file: $COMPOSE_FILE"

# Pick an env file if one was not named. Never silently: a stack pointed
# at the wrong database looks like it is working right up until it is not.
if [[ -z "$ENV_FILE" ]]; then
  candidates=()
  for f in .env.azure .env.production .env; do [[ -f "$f" ]] && candidates+=("$f"); done
  if [[ ${#candidates[@]} -eq 1 ]]; then
    ENV_FILE="${candidates[0]}"
    info "using env file: $ENV_FILE"
  elif [[ ${#candidates[@]} -gt 1 && -t 0 ]]; then
    info "which env file?"
    select choice in "${candidates[@]}"; do [[ -n "${choice:-}" ]] && { ENV_FILE="$choice"; break; }; done
  else
    die "no env file given. Pass --env-file <path> (see .env.azure.example for the shape)."
  fi
fi
[[ -f "$ENV_FILE" ]] || die "no such env file: $ENV_FILE"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# Only the services this repo actually builds are offered. Postgres and
# SuperTokens come from upstream images, so "build" is meaningless for
# them — but they still need to be running, which `up` handles through
# depends_on.
#
# Read out of the resolved compose config with python3 rather than awk:
# the config is YAML with nesting that line-oriented matching gets wrong,
# and `mapfile` is bash 4+, which macOS does not ship.
BUILDABLE=()
while IFS= read -r svc; do
  [[ -n "$svc" ]] && BUILDABLE+=("$svc")
done < <(compose config 2>/dev/null | python3 -c '
import sys, re
# A minimal walk of the services block: a service is buildable when it
# has a build: key at its own indent level.
lines = sys.stdin.read().split("\n")
try:
    start = next(i for i, l in enumerate(lines) if l.startswith("services:"))
except StopIteration:
    sys.exit(0)
current, indent = None, None
for line in lines[start + 1:]:
    if line and not line[0].isspace():
        break
    m = re.match(r"^(\s+)([A-Za-z0-9._-]+):\s*$", line)
    if m and (indent is None or len(m.group(1)) == indent):
        indent = len(m.group(1)); current = m.group(2); continue
    if current and re.match(r"^\s+build:", line):
        print(current); current = None
')

[[ ${#BUILDABLE[@]} -gt 0 ]] || die "found no buildable services in $COMPOSE_FILE"

# Resolve what to act on.
if [[ ${#SELECTED[@]} -gt 0 ]]; then
  for s in "${SELECTED[@]}"; do
    printf '%s\n' "${BUILDABLE[@]}" | grep -qx "$s" \
      || die "'$s' is not a buildable service. Available: ${BUILDABLE[*]}"
  done
elif [[ $ASSUME_ALL -eq 1 ]]; then
  SELECTED=("${BUILDABLE[@]}")
elif [[ ! -t 0 ]]; then
  # No terminal to ask on, and no explicit choice: refuse rather than
  # assume "everything", which is the slow and surprising option.
  die "not a terminal — pass --all or name the services explicitly"
else
  echo
  info "which services? ($COMPOSE_FILE, env $ENV_FILE)"
  echo "   0) all of them"
  for i in "${!BUILDABLE[@]}"; do printf '  %2d) %s\n' "$((i + 1))" "${BUILDABLE[$i]}"; done
  echo
  read -rp "  numbers, space separated [0]: " -a picks
  [[ ${#picks[@]} -eq 0 ]] && picks=(0)
  for p in "${picks[@]}"; do
    [[ "$p" =~ ^[0-9]+$ ]] || die "'$p' is not a number"
    if [[ "$p" == "0" ]]; then SELECTED=("${BUILDABLE[@]}"); break; fi
    idx=$((p - 1))
    [[ -n "${BUILDABLE[$idx]:-}" ]] || die "no service number $p"
    SELECTED+=("${BUILDABLE[$idx]}")
  done
fi

echo
info "services: ${SELECTED[*]}"

started=$(date +%s)
if [[ $DO_BUILD -eq 1 ]]; then
  info "building"
  # The Dockerfiles use BuildKit cache mounts for npm, apt and Next's
  # compiler cache, so this must not fall back to the legacy builder.
  DOCKER_BUILDKIT=1 compose build "${SELECTED[@]}"
  ok "built in $(( $(date +%s) - started ))s"
fi

if [[ $DO_RUN -eq 1 ]]; then
  info "starting"
  # Named services only, so an unrelated service already running is left
  # alone; depends_on still pulls up Postgres and SuperTokens.
  compose up -d "${SELECTED[@]}"
  echo
  compose ps
  echo
  ok "up. Logs:  docker compose -f $COMPOSE_FILE --env-file $ENV_FILE logs -f ${SELECTED[*]}"
fi
