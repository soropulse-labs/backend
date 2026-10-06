# Contributing

Use Node.js 22.23.2 and pnpm 9.15.9. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build` before opening a pull request. Start PostgreSQL with `docker compose up -d postgres` and apply migrations with `pnpm db:migrate` before integration tests. Include a migration for schema changes. Keep fixtures labeled by provenance and do not commit credentials or `.env` files. Ordinary PR tests must remain independent of live testnet and OAuth credentials.
