ALTER TABLE "ingestion_streams" ADD COLUMN "halted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_streams" ADD COLUMN "halt_reason" text;