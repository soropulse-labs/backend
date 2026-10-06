# Build status

As of 2026-10-06, implementation is in progress on `feat/soropulse-backend-mvp`. The NebGov working tree has been removed from this branch; all original commits remain in Git history. The default branch has not been replaced.

Contracts integration source: `soropulse-labs/contracts` commit `34a2beb2bc9f189e3c0d25023b90ea5a54132cc6`. Its manifest records testnet contract `CAUKWP7TRYYXAF2C5NDAZEAQVWCUMXX76KBPK64MQBZHU7EUJ5JVPHGG`, deployed from source commit `b478355c44722db0ddef5c31ec14324f013d939c`. The fixture is locally generated XDR, not a testnet capture.

Implemented so far: pinned Node/TypeScript/Fastify/PostgreSQL/Drizzle configuration and lockfile; two migrations; generic RPC ingestion with a separate ticket decoder; PostgreSQL-backed delivery worker; exact-byte HMAC protocol helper; GitHub OAuth and tenant-scoped API foundation; processing receipts, trace and replay routes; isolated ticket consumer; local Docker Compose. These components have not passed an end-to-end delivery or live test.

Verified locally after session recovery: `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` passed (three unit test files). `pnpm db:migrate` applied three migrations to a local PostgreSQL 16 container. `pnpm test:integration` passed one real-PostgreSQL test proving that two tenant environments capture the same two events independently, create four separate jobs, and advance both checkpoints. Dependency installation and Drizzle migration generation passed. No end-to-end delivery, backend deployment, or live testnet integration has passed. The Docker image build was started but has not yet completed.

Next tasks: expand PostgreSQL integration coverage to delivery, receipt and replay failure boundaries; implement the failure lab; finish security review, OpenAPI and frontend handoff, deployment tooling and live smoke test. CI is configured but has not yet run on GitHub. The current branch is not ready to merge as a complete MVP.
