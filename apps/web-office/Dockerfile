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
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEBSITE_DOMAIN
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WEBSITE_DOMAIN=$NEXT_PUBLIC_WEBSITE_DOMAIN
RUN npm run build --workspace=@ovl/database
RUN npm run build --workspace=web-office

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
