# Optimized production image for api-vessel (NestJS + SQLite).
# Build from the monorepo root: docker build -f apps/api-vessel/Dockerfile -t ovl-api-vessel .

FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
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
RUN npm ci
COPY . .
RUN npm run build --workspace=@ovl/vessel-database
RUN npm run build --workspace=api-vessel

# Fresh, dev-dependency-free install for the runtime layer (also
# recompiles better-sqlite3's native binding against this same base
# image, so build tools are needed here too).
FROM node:22-bookworm-slim AS prod-deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
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
RUN npm ci --omit=dev

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
