# Frontend handoff (draft)

The API base path is `/v1`. Dashboard users authenticate via `GET /v1/auth/github`; OAuth callback redirects to `FRONTEND_ORIGIN`. Development-only `POST /v1/auth/dev-login` is available when explicitly enabled. `GET /v1/auth/me` returns current user and a CSRF token; `POST /v1/auth/logout` revokes the session. Browser requests need credentials and the configured exact CORS origin. For deployments, keep frontend and API on the same site when practical so `SameSite=Lax` cookies work; serve both over HTTPS in production. Mutating session requests send `X-CSRF-Token`.

The current API route groups are:

| Area | Paths |
| --- | --- |
| Projects and environments | `/v1/projects`, `/v1/projects/:id/environments` |
| API keys | `/v1/projects/:id/api-keys`, `/v1/projects/:id/api-keys/:keyId/revoke` |
| Endpoints | `/v1/environments/:id/endpoints`, `/v1/endpoints/:id/verify`, `/v1/endpoints/:id/disable` |
| Subscriptions and consumers | `/v1/environments/:id/subscriptions`, `/v1/subscriptions/:id/disable`, `/v1/environments/:id/consumers`, `/v1/consumers/:id/credentials/:credentialId/revoke` |
| Event evidence | `/v1/environments/:id/events`, `/v1/environments/:id/events/:eventId`, `/v1/environments/:id/transactions/:hash`, `/v1/environments/:id/coverage-incidents` |
| Delivery evidence | `/v1/environments/:id/deliveries`, `/v1/environments/:id/deliveries/:deliveryId` |
| Replay | `/v1/environments/:id/replay-plans`, `/v1/environments/:id/replay-plans/:planId`, and `:planId/execute`, `:planId/pause`, `:planId/resume`, `:planId/cancel` |
| Health | `/v1/health/live`, `/v1/health/ready` |

Responses use a request ID in error envelopes. Lists are bounded and use `limit` and `offset` where implemented. The trace response separates `capture`, `transport`, and `application` dimensions. A missing local event is inconclusive evidence of a blockchain event's absence; show the explanation and coverage incidents instead of a definitive "no event" claim. `POST /v1/processing-receipts` uses server-held consumer credentials and must not be called from the browser.

The OpenAPI document and typed client are not yet complete. Frontend implementation should start with login, project/environment selection, events, delivery attempts, receipts, and replay preview. Do not present replay execution as enabled until backend integration and security tests pass. See [build status](BUILD_STATUS.md).
