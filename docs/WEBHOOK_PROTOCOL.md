# Webhook protocol v1

Each delivery is an HTTP POST of UTF-8 JSON. The exact transmitted body bytes are signed. Headers are `SoroPulse-Id` (delivery UUID), `SoroPulse-Timestamp` (ten-digit Unix seconds), `SoroPulse-Key-Id` (signing-key UUID), and `SoroPulse-Signature` (`v1=` plus lowercase HMAC-SHA256 hex). The signing input is ASCII `v1.<timestamp>.<delivery-id>.` followed immediately by the raw body bytes. The signing secret is revealed once when the endpoint is registered and encrypted at rest. A receiver should validate timestamp within five minutes, key ID, HMAC in constant time, and equality of header and body delivery IDs before processing.

The payload includes `schema_version`, blockchain `event_id`, `delivery_id`, `network`, `epoch`, `contract_id`, `transaction_hash`, `ledger`, nullable `ledger_closed_at`, `raw.topics_xdr`, `raw.value_xdr`, nullable `decoded`, and nullable `replay.plan_id`. The blockchain event ID is separate from the ticket contract's decimal-string business `event_id` and `reservation_id`. Never deduplicate on transaction hash: one transaction can emit multiple events.

Use `verifyWebhook` in [`src/protocol/webhook.ts`](../src/protocol/webhook.ts) against the original request bytes. The example consumer demonstrates durable inbox acceptance before HTTP 202. Automatic retries retain the delivery ID. Controlled replay creates a new delivery ID while preserving blockchain event identity. A 2xx is a transport acknowledgement; processing receipts provide optional application-reported status.

Endpoint verification sends a separately signed JSON object `{ "type": "soropulse.endpoint.verify", "challenge": "<48 hex characters>" }`. The receiver must validate its signature and reply HTTP 200 with the challenge string as the entire response body. The example consumer handles this challenge.

Endpoint versioning pins pending jobs to the URL and signing key selected when the job was created. This MVP does not yet expose key rotation or endpoint destination edits; register a new endpoint and subscription for a replacement, then disable the old subscription and endpoint after its pending jobs are handled.
