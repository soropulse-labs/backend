FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY examples ./examples
COPY drizzle ./drizzle
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY examples/ticket-consumer/schema.sql ./dist/examples/ticket-consumer/schema.sql
COPY package.json pnpm-lock.yaml ./
USER node
CMD ["node", "dist/src/api/main.js"]
