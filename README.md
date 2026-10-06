# SoroPulse backend

SoroPulse captures Stellar Soroban contract events, delivers signed webhooks, and records delivery and application-processing evidence. This repository runs independently of the [contracts](https://github.com/soropulse-labs/contracts) and frontend repositories. The reference ticket decoder is optional; generic event capture and raw XDR delivery do not require it.

This branch is an **in-progress MVP**. See [build status](docs/BUILD_STATUS.md) for verified results and gaps before using it beyond local development.

## Local setup

Use Node.js 22.23.2, pnpm 9.15.9, Docker, and PostgreSQL 16. Copy `.env.example` to `.env`. Generate independent random values for `SESSION_SECRET` (at least 32 characters) and `ENCRYPTION_KEY` (32 bytes encoded as 64 hex characters); do not commit `.env`. Configure GitHub OAuth credentials for dashboard login, or set `DEV_AUTH_ENABLED=true` only in development. The local consumer additionally needs the one-time values returned by the API for its consumer credential and endpoint signing key; see [operations](docs/OPERATIONS.md).

```sh
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
docker compose up -d postgres
pnpm db:migrate
pnpm dev:api
pnpm dev:ingest
pnpm dev:deliver
```

Each `dev:*` command runs in its own terminal. `pnpm dev:consumer` runs the isolated ticket consumer once its environment variables are configured. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and `pnpm build` check the code. Integration tests require a migrated PostgreSQL database. `docker compose` also defines containerized API and worker processes; see [operations](docs/OPERATIONS.md) for setup and limitations.

The API listens on `http://localhost:3001` by default. Liveness is `/v1/health/live` and database readiness is `/v1/health/ready`. The workers are continuously running processes; a request-only serverless host cannot ingest or deliver in the background.

The reference contract schema is pinned to `soropulse-labs/contracts` commit `34a2beb2bc9f189e3c0d25023b90ea5a54132cc6`. The documented testnet contract is `CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG`. A local smoke test captured two live testnet reservation events and delivered them to a temporary local receiver; see [build status](docs/BUILD_STATUS.md). The checked-in XDR fixture was locally generated, not captured from testnet.

The backend owns webhook delivery, retries, receipts, and replay. A consumer must deduplicate event identity and apply business changes transactionally; an HTTP 2xx alone proves only transport acknowledgement.
