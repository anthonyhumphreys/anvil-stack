FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/config/package.json packages/config/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile=false --ignore-scripts

COPY packages packages

RUN pnpm --filter @anvilstack/persistence... build

CMD ["pnpm", "--filter", "@anvilstack/persistence", "db:migrate"]
