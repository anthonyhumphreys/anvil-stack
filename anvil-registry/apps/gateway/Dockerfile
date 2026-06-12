FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/name-squatting/package.json packages/name-squatting/package.json
COPY packages/npm-registry/package.json packages/npm-registry/package.json
COPY packages/object-store/package.json packages/object-store/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/policy-engine/package.json packages/policy-engine/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile=false --ignore-scripts

FROM deps AS build
COPY packages packages
COPY apps/gateway apps/gateway
RUN pnpm --filter @anvilstack/registry... build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/gateway/node_modules /app/apps/gateway/node_modules
COPY --from=build /app/packages /app/packages
COPY --from=build /app/apps/gateway /app/apps/gateway
EXPOSE 4873
CMD ["node", "apps/gateway/dist/index.js"]
