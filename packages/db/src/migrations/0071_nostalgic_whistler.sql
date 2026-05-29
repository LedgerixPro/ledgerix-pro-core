CREATE TABLE "audit_archives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"row_count" integer NOT NULL,
	"sha256" text,
	"window_from" timestamp with time zone,
	"window_to" timestamp with time zone,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_archives_company_idx" ON "audit_archives" USING btree ("company_id","archived_at");