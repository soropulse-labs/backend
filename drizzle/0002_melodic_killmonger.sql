DROP INDEX "events_identity_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "events_identity_idx" ON "captured_events" USING btree ("environment_id","network","epoch","contract_id","rpc_event_id");