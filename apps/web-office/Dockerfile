# syntax=docker/dockerfile:1
# Declared so the RUN --mount=type=cache steps below are always
# understood, including by the legacy builder path.
# Optimized production image for web-office (Next.js standalone output).
# Build from the monorepo root: docker build -f apps/web-office/Dockerfile -t ovl-web-office .

FROM node:22-bookworm-slim AS builder
WORKDIR /app
# web-office needs api-office's package.json present (trpc.ts does a
# type-only cross-workspace import of its AppRouter type) but nothing
# from api-vessel/web-vessel — omitting those keeps better-sqlite3 (a
# native module needing build tools) out of this build entirely.
COPY package.json package-lock.json ./
COPY apps/api-office/package.json apps/api-office/package.json
COPY apps/web-office/package.json apps/web-office/package.json
COPY packages/database/package.json packages/database/package.json
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
COPY packages/ui packages/ui
COPY apps/api-office apps/api-office
COPY apps/web-office apps/web-office
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEBSITE_DOMAIN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WEBSITE_DOMAIN=$NEXT_PUBLIC_WEBSITE_DOMAIN
RUN npm run build --workspace=@ovl/database
# Next.js keeps its compiler cache under .next/cache, and a container
# build starts without it every time — which is why this step took over
# seven minutes on the server while the compile itself reported 5.7min.
# Mounting it as a build cache lets a rebuild reuse the previous
# compilation instead of starting from nothing. Next documents this as
# the supported way to cache in Docker.
#
# NEXT_TELEMETRY_DISABLED also removes a network call from the build,
# which matters more on a VM with a slow uplink than on a laptop.
RUN --mount=type=cache,target=/app/apps/web-office/.next/cache \
    NEXT_TELEMETRY_DISABLED=1 npm run build --workspace=web-office

# Standalone output already contains a minimal, traced node_modules, and
# both native deps it pulls in (sharp for image optimization, argon2
# transitively) ship musl-compatible prebuilt binaries — Alpine's much
# smaller base (~50MB vs bookworm-slim's ~260MB) needs no native
# recompilation here.
FROM node:22-alpine AS runtime
RUN apk add --no-cache libc6-compat
WORKDIR /app
# Next.js standalone's server.js binds to PORT (default 3000) regardless
# of EXPOSE — set explicitly for consistency with the other services.
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=builder /app/apps/web-office/.next/standalone ./
COPY --from=builder /app/apps/web-office/.next/static ./apps/web-office/.next/static
COPY --from=builder /app/apps/web-office/public ./apps/web-office/public
EXPOSE 3000
CMD ["node", "apps/web-office/server.js"]
