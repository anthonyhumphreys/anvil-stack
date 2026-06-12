FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/name-squatting/package.json packages/name-squatting/package.json
COPY packages/object-store/package.json packages/object-store/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile=false --ignore-scripts

FROM deps AS build
COPY packages packages
COPY apps/admin apps/admin
RUN pnpm --filter @anvilstack/admin... build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/admin/.next/standalone ./
COPY --from=build /app/apps/admin/.next/static ./apps/admin/.next/static
COPY --from=build /app/apps/admin/public ./apps/admin/public
EXPOSE 3000
CMD ["node", "apps/admin/server.js"]
