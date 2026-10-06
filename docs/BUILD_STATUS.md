# Build status

As of 2026-10-06, implementation is in progress on `feat/soropulse-backend-mvp`. The NebGov working tree has been removed from this branch; all original commits remain in Git history. The default branch has not been replaced.

Contracts integration source: `soropulse-labs/contracts` commit `34a2beb2bc9f189e3c0d25023b90ea5a54132cc6`. Its manifest records testnet contract `CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG`, deployed from source commit `b478355c44722db0ddef5c31ec14324f013d939c`. The fixture is locally generated XDR, not a testnet capture.

Implemented so far: pinned Node/TypeScript/Fastify/PostgreSQL/Drizzle configuration and lockfile; two migrations; generic RPC ingestion with a separate ticket decoder; PostgreSQL-backed delivery worker; exact-byte HMAC protocol helper; GitHub OAuth and tenant-scoped API foundation; processing receipts, trace and replay routes; isolated ticket consumer; local Docker Compose. These components have not passed an end-to-end delivery or live test.

Verified locally after session recovery: `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` passed (four unit test files). `pnpm db:migrate` applied three migrations to a local PostgreSQL 16 container. `pnpm test:integration` passed one real-PostgreSQL test proving that two tenant environments capture the same two events independently, create four separate jobs, advance both checkpoints, and permit four distinct concurrent delivery claims. The Docker API image built. `docker compose up -d api` completed its migration job and started the API, which returned HTTP 200 from `/v1/health/ready`. No end-to-end delivery, hosted backend deployment, or live testnet integration has passed.

Stellar testnet RPC `getHealth` returned `healthy` with oldest ledger 4,924,540 and latest ledger 5,045,499 on 2026-10-06. A `getEvents` query for the pinned contract over ledgers 4,990,360–4,990,361 returned an empty `events` array. This proves RPC availability for that query, not contract or backend integration. The reference contract may emit events outside that narrow window; no claim about live event capture follows from the empty response.

Next tasks: expand PostgreSQL integration coverage to delivery, receipt and replay failure boundaries; implement the failure lab; finish security review, OpenAPI and frontend handoff, deployment tooling and live smoke test. CI is configured but has not yet run on GitHub. The current branch is not ready to merge as a complete MVP.
