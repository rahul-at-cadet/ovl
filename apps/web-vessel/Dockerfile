# syntax=docker/dockerfile:1
# Declared so the RUN --mount=type=cache steps below are always
# understood, including by the legacy builder path.
# Optimized production image for web-vessel (Next.js standalone output).
# Build from the monorepo root: docker build -f apps/web-vessel/Dockerfile -t ovl-web-vessel .

FROM node:22-bookworm-slim AS builder
# web-vessel's tRPC client does a type-only cross-workspace import of
# api-vessel's AppRouter, and TypeScript has to fully resolve that
# module's transitive imports to compute the type — which pulls in
# api-vessel's own dependency tree, including better-sqlite3 (a native
# module), so build tools are needed here even though web-vessel itself
# has none. The chain goes one hop further too: api-vessel's
# trpc.router.ts imports trpc.service.ts, which does its OWN type-only
# import of api-office's AppRouter — so api-office's package.json and
# @ovl/database (which api-office's source imports) are needed here as
# well, even though web-vessel never touches either directly.
# Cache mounts so a cold build does not re-download the toolchain and
# every npm tarball again. Shared across all four images by default,
# so eight npm installs draw on one cache.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get update && apt-get install -y python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY apps/api-vessel/package.json apps/api-vessel/package.json
COPY apps/web-vessel/package.json apps/web-vessel/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/vessel-database/package.json packages/vessel-database/package.json
# @ovl/ui is a workspace in package-lock.json, so npm ci needs its manifest
# present or the install fails before any source is copied.
COPY packages/ui/package.json packages/ui/package.json
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
COPY packages/ui packages/ui
COPY apps/api-office apps/api-office
COPY apps/api-vessel apps/api-vessel
COPY apps/web-vessel apps/web-vessel
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEBSITE_DOMAIN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WEBSITE_DOMAIN=$NEXT_PUBLIC_WEBSITE_DOMAIN
RUN npm run build --workspace=@ovl/database
RUN npm run build --workspace=@ovl/vessel-database
# Next.js keeps its compiler cache under .next/cache, and a container
# build starts without it every time — which is why this step took over
# seven minutes on the server while the compile itself reported 5.7min.
# Mounting it as a build cache lets a rebuild reuse the previous
# compilation instead of starting from nothing. Next documents this as
# the supported way to cache in Docker.
#
# NEXT_TELEMETRY_DISABLED also removes a network call from the build,
# which matters more on a VM with a slow uplink than on a laptop.
RUN --mount=type=cache,target=/app/apps/web-vessel/.next/cache \
    NEXT_TELEMETRY_DISABLED=1 npm run build --workspace=web-vessel

# Standalone output already contains a minimal, traced node_modules, and
# the native deps it pulls in (sharp for image optimization) ship
# musl-compatible prebuilt binaries — Alpine's much smaller base needs
# no native recompilation here (better-sqlite3 stays behind in the
# builder stage's type-check-only install and never reaches standalone
# tracing since web-vessel doesn't import api-vessel at runtime, only
# its types).
FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Next.js standalone's server.js binds to PORT (default 3000) regardless
# of EXPOSE — has to be set explicitly or it silently listens on 3000.
ENV NODE_ENV=production
ENV PORT=3002
COPY --from=builder /app/apps/web-vessel/.next/standalone ./
COPY --from=builder /app/apps/web-vessel/.next/static ./apps/web-vessel/.next/static
COPY --from=builder /app/apps/web-vessel/public ./apps/web-vessel/public
EXPOSE 3002
CMD ["node", "apps/web-vessel/server.js"]
