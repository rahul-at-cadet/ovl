# syntax=docker/dockerfile:1
# Declared so the RUN --mount=type=cache steps below are always
# understood, including by the legacy builder path.
# Optimized production image for api-vessel (NestJS + SQLite).
# Build from the monorepo root: docker build -f apps/api-vessel/Dockerfile -t ovl-api-vessel .

FROM node:22-bookworm-slim AS builder
# Cache mounts so a cold build does not re-download the toolchain and
# every npm tarball again. Shared across all four images by default,
# so eight npm installs draw on one cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y python3 make g++
WORKDIR /app
# api-office's package.json has to stay (trpc.service.ts does a
# type-only cross-workspace import of its AppRouter type for tRPC
# inference), but the two web apps aren't referenced anywhere here —
# omitting their package.json means Next.js/React never land in this
# image. Confirmed empirically: 768MB with all 4 apps present, 157MB
# scoped to just these two + their two database packages.
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY apps/api-vessel/package.json apps/api-vessel/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/vessel-database/package.json packages/vessel-database/package.json
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
COPY packages/vessel-database packages/vessel-database
COPY apps/api-office apps/api-office
COPY apps/api-vessel apps/api-vessel
# api-vessel never imports @ovl/database itself, but nest build
# type-checks the whole chain behind trpc.service.ts's type-only
# AppRouter import — which reaches into api-office's source, which
# does import it. Without building it here, that resolves to a bare
# package.json with no dist/, and tsc fails with "Cannot find module".
RUN npm run build --workspace=@ovl/database
RUN npm run build --workspace=@ovl/vessel-database
RUN npm run build --workspace=api-vessel

# Fresh, dev-dependency-free install for the runtime layer (also
# recompiles better-sqlite3's native binding against this same base
# image, so build tools are needed here too).
FROM node:22-bookworm-slim AS prod-deps
# Cache mounts so a cold build does not re-download the toolchain and
# every npm tarball again. Shared across all four images by default,
# so eight npm installs draw on one cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y python3 make g++
WORKDIR /app
# api-office's package.json has to stay (trpc.service.ts does a
# type-only cross-workspace import of its AppRouter type for tRPC
# inference), but the two web apps aren't referenced anywhere here —
# omitting their package.json means Next.js/React never land in this
# image. Confirmed empirically: 768MB with all 4 apps present, 157MB
# scoped to just these two + their two database packages.
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY apps/api-vessel/package.json apps/api-vessel/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/vessel-database/package.json packages/vessel-database/package.json
RUN --mount=type=cache,target=/root/.npm --mount=type=cache,target=/root/.cache/node-gyp npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
# npm nests a workspace-specific node_modules when a dep version
# conflicts with what's hoisted to the root (better-sqlite3 here) —
# has to be copied separately, the root node_modules copy above
# doesn't include it.
COPY --from=prod-deps /app/apps/api-vessel/node_modules ./apps/api-vessel/node_modules
COPY --from=builder /app/packages/vessel-database/dist ./packages/vessel-database/dist
COPY --from=builder /app/packages/vessel-database/package.json ./packages/vessel-database/package.json
COPY --from=builder /app/packages/vessel-database/drizzle ./packages/vessel-database/drizzle
COPY --from=builder /app/apps/api-vessel/dist ./apps/api-vessel/dist
COPY --from=builder /app/apps/api-vessel/package.json ./apps/api-vessel/package.json
COPY --from=builder /app/apps/api-vessel/src/schemas ./apps/api-vessel/src/schemas
WORKDIR /app/apps/api-vessel
EXPOSE 3003
CMD ["node", "dist/main"]
