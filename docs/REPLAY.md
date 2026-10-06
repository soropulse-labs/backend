# Controlled replay

`POST /v1/environments/:id/replay-plans` previews up to 100 stored delivery IDs for one verified endpoint. It requires a dashboard session, an endpoint ID, a reason of 10–500 characters, and optional `include_reported_successes`. Preview persists a ten-minute plan, selected event/subscription identities, endpoint version, network epoch, exclusions, and SHA-256 digest; it sends no webhook. Application-reported successes are excluded by default.

`POST /v1/environments/:id/replay-plans/:planId/execute` checks session ownership, expiry, epoch, current endpoint version, and reported successes again. It queues idempotent replay delivery jobs with new delivery IDs and the original blockchain event IDs. Replaying known successes requires both preview inclusion and explicit `acknowledge_reported_successes: true` at execution. `GET` on the plan path shows status and delivery counts. The `/pause`, `/resume`, and `/cancel` actions affect unsent jobs; an in-flight request cannot be recalled.

Replay cannot recreate events never captured, undo a business operation, or guarantee exactly-once processing. Consumers must retain event deduplication across the replay horizon. The current implementation still needs full race and stale-plan integration tests before production use.
