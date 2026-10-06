CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"project_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "captured_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"network" text NOT NULL,
	"epoch" text NOT NULL,
	"contract_id" text NOT NULL,
	"rpc_event_id" text NOT NULL,
	"tx_hash" text NOT NULL,
	"ledger" bigint NOT NULL,
	"ledger_closed_at" timestamp with time zone,
	"topic_xdr" text[] NOT NULL,
	"value_xdr" text NOT NULL,
	"decoded" jsonb,
	"decoder" text,
	"decode_error" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consumer_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"consumer_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "consumer_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "consumers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coverage_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"subscription_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"from_ledger" bigint,
	"to_ledger" bigint,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"endpoint_version_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"attempt_started_at" timestamp with time zone,
	"replay_plan_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"http_status" integer,
	"failure_class" text,
	"response_preview" text
);
--> statement-breakpoint
CREATE TABLE "endpoint_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"url" text NOT NULL,
	"signing_secret_cipher" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"name" text NOT NULL,
	"active_version_id" uuid,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"network" text DEFAULT 'testnet' NOT NULL,
	"epoch" text NOT NULL,
	"rpc_url" text NOT NULL,
	"network_passphrase" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"scenario" text NOT NULL,
	"budget" integer NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"code_verifier_cipher" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" text NOT NULL,
	"environment_id" uuid NOT NULL,
	"consumer_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"processing_run_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"status" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"error" text,
	"business_reference" text,
	"body_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_items" (
	"plan_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"eligibility" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "replay_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"endpoint_version_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"criteria" jsonb NOT NULL,
	"digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "ingestion_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"next_ledger" bigint NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_streams_subscription_id_unique" UNIQUE("subscription_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"contract_id" text NOT NULL,
	"topic0_xdr" text,
	"decoder" text,
	"start_ledger" bigint NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_id" text NOT NULL,
	"login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_records" ADD CONSTRAINT "audit_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captured_events" ADD CONSTRAINT "captured_events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumer_credentials" ADD CONSTRAINT "consumer_credentials_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consumers" ADD CONSTRAINT "consumers_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_incidents" ADD CONSTRAINT "coverage_incidents_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coverage_incidents" ADD CONSTRAINT "coverage_incidents_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_event_id_captured_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."captured_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_endpoint_version_id_endpoint_versions_id_fk" FOREIGN KEY ("endpoint_version_id") REFERENCES "public"."endpoint_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_versions" ADD CONSTRAINT "endpoint_versions_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_sessions" ADD CONSTRAINT "lab_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_sessions" ADD CONSTRAINT "lab_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_receipts" ADD CONSTRAINT "processing_receipts_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_receipts" ADD CONSTRAINT "processing_receipts_consumer_id_consumers_id_fk" FOREIGN KEY ("consumer_id") REFERENCES "public"."consumers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_receipts" ADD CONSTRAINT "processing_receipts_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_receipts" ADD CONSTRAINT "processing_receipts_event_id_captured_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."captured_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_items" ADD CONSTRAINT "replay_items_plan_id_replay_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."replay_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_items" ADD CONSTRAINT "replay_items_event_id_captured_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."captured_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_items" ADD CONSTRAINT "replay_items_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_plans" ADD CONSTRAINT "replay_plans_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_plans" ADD CONSTRAINT "replay_plans_endpoint_version_id_endpoint_versions_id_fk" FOREIGN KEY ("endpoint_version_id") REFERENCES "public"."endpoint_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_plans" ADD CONSTRAINT "replay_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_streams" ADD CONSTRAINT "ingestion_streams_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_identity_idx" ON "captured_events" USING btree ("network","epoch","contract_id","rpc_event_id");--> statement-breakpoint
CREATE INDEX "events_env_ledger_idx" ON "captured_events" USING btree ("environment_id","ledger");--> statement-breakpoint
CREATE INDEX "events_env_tx_idx" ON "captured_events" USING btree ("environment_id","tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_initial_idx" ON "deliveries" USING btree ("event_id","subscription_id") WHERE "deliveries"."replay_plan_id" IS NULL;--> statement-breakpoint
CREATE INDEX "delivery_queue_idx" ON "deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_number_idx" ON "delivery_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_version_idx" ON "endpoint_versions" USING btree ("endpoint_id","version");--> statement-breakpoint
CREATE INDEX "endpoints_env_idx" ON "endpoints" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "env_project_name_idx" ON "environments" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "env_epoch_idx" ON "environments" USING btree ("network","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_identity_idx" ON "processing_receipts" USING btree ("consumer_id","receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_run_sequence_idx" ON "processing_receipts" USING btree ("consumer_id","delivery_id","processing_run_id","sequence");--> statement-breakpoint
CREATE INDEX "receipt_delivery_idx" ON "processing_receipts" USING btree ("delivery_id","received_at");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "replay_item_idx" ON "replay_items" USING btree ("plan_id","event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "subscriptions_env_idx" ON "subscriptions" USING btree ("environment_id");