CREATE TABLE IF NOT EXISTS inbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  epoch text NOT NULL,
  contract_id text NOT NULL,
  rpc_event_id text NOT NULL,
  reservation_id text NOT NULL,
  business_event_id text NOT NULL,
  attendee text NOT NULL,
  payload_hash text NOT NULL,
  processing_run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE(network,epoch,contract_id,rpc_event_id)
);
CREATE TABLE IF NOT EXISTS inbox_deliveries (
  delivery_id uuid PRIMARY KEY,
  inbox_id uuid NOT NULL REFERENCES inbox_events(id),
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  network text NOT NULL,
  epoch text NOT NULL,
  contract_id text NOT NULL,
  reservation_id text NOT NULL,
  rpc_event_id text NOT NULL,
  business_event_id text NOT NULL,
  attendee text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(network,epoch,contract_id,reservation_id),
  UNIQUE(network,epoch,contract_id,rpc_event_id)
);
CREATE TABLE IF NOT EXISTS receipt_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL UNIQUE REFERENCES inbox_deliveries(delivery_id),
  body jsonb NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text
);
CREATE INDEX IF NOT EXISTS receipt_outbox_pending_idx ON receipt_outbox(next_attempt_at) WHERE sent_at IS NULL;
