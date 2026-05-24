CREATE TABLE "write_thresholds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ghl_contact_id" text,
	"endpoint" text NOT NULL,
	"field" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold_value" integer NOT NULL,
	"action" text DEFAULT 'require_approval' NOT NULL,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "write_thresholds_endpoint_contact_idx" ON "write_thresholds" USING btree ("endpoint","ghl_contact_id");