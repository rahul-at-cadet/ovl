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
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
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
RUN npm ci
COPY . .
RUN npm run build --workspace=@ovl/database
RUN npm run build --workspace=@ovl/vessel-database
RUN npm run build --workspace=web-vessel

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
