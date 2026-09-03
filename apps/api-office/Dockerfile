# syntax=docker/dockerfile:1
# Declared so the RUN --mount=type=cache steps below are always
# understood, including by the legacy builder path.
# Optimized production image for api-office (NestJS + Postgres).
# Build from the monorepo root: docker build -f apps/api-office/Dockerfile -t ovl-api-office .

FROM node:22-bookworm-slim AS builder
# npm workspaces' single lockfile installs every workspace's deps
# regardless of which app this Dockerfile targets — api-vessel's
# better-sqlite3 (a native module) is always in that install, so build
# tools are needed here even though api-office itself has none.
# Cache mounts so a cold build does not re-download the toolchain and
# every npm tarball again. Shared across all four images by default,
# so eight npm installs draw on one cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y python3 make g++
WORKDIR /app
# Only api-office's own package.json (+ the one package it actually
# depends on) — omitting the other 3 apps' package.json entirely means
# npm's workspace resolution never sees them, so their dependencies
# (Next.js/React for the two web apps, better-sqlite3 for api-vessel)
# never land in this image at all. Confirmed empirically: with all 4
# apps present, "production" node_modules was 768MB; scoped to just
# this one, 144MB.
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY packages/database/package.json packages/database/package.json
RUN --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.cache/node-gyp npm ci
# Scoped rather than `COPY . .`.
#
# The whole tree in one layer meant any change anywhere invalidated it,
# so editing a stylesheet in web-office rebuilt api-vessel's entire
# TypeScript chain — measured, not assumed. Every image recompiled on
# every change to any of them.
#
# These are the workspaces this image actually compiles, plus the ones
# reached by the type-only cross-imports the comments above describe.
# Adding a workspace this image depends on means adding it here.
COPY turbo.json ./
COPY packages/database packages/database
COPY apps/api-office apps/api-office
RUN npm run build --workspace=@ovl/database
RUN npm run build --workspace=api-office

# Fresh, dev-dependency-free install for the runtime layer — leaner and
# more correct than pruning the builder stage's node_modules in place.
FROM node:22-bookworm-slim AS prod-deps
# Cache mounts so a cold build does not re-download the toolchain and
# every npm tarball again. Shared across all four images by default,
# so eight npm installs draw on one cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y python3 make g++
WORKDIR /app
# Only api-office's own package.json (+ the one package it actually
# depends on) — omitting the other 3 apps' package.json entirely means
# npm's workspace resolution never sees them, so their dependencies
# (Next.js/React for the two web apps, better-sqlite3 for api-vessel)
# never land in this image at all. Confirmed empirically: with all 4
# apps present, "production" node_modules was 768MB; scoped to just
# this one, 144MB.
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY packages/database/package.json packages/database/package.json
RUN --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.cache/node-gyp npm ci --omit=dev

# argon2 (password hashing) ships a musl-compatible prebuilt binary, so
# Alpine's much smaller base needs no native recompilation here.
FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
# npm nests a workspace-specific node_modules when a dep version
# conflicts with what's hoisted to the root (e.g. ajv@8 here vs. the
# root's ajv@6, needed by an unrelated tool) — has to be copied
# separately, the root node_modules copy above doesn't include it.
COPY --from=prod-deps /app/apps/api-office/node_modules ./apps/api-office/node_modules
COPY --from=builder /app/packages/database/dist ./packages/database/dist
COPY --from=builder /app/packages/database/package.json ./packages/database/package.json
COPY --from=builder /app/apps/api-office/dist ./apps/api-office/dist
COPY --from=builder /app/apps/api-office/package.json ./apps/api-office/package.json
# SchemaVersionsService reads these from process.cwd() + src/schemas at
# runtime to seed the curated schema set — mirrors api-vessel's own
# Dockerfile, which needs the identical line for its schema registry.
COPY --from=builder /app/apps/api-office/src/schemas ./apps/api-office/src/schemas
WORKDIR /app/apps/api-office
EXPOSE 3001
CMD ["node", "dist/main"]
