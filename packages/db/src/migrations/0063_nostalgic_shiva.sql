CREATE TABLE "sms_consent_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" text,
	"email" text,
	"phone" text NOT NULL,
	"consent_granted" boolean NOT NULL,
	"consent_text" text NOT NULL,
	"consent_text_version" text NOT NULL,
	"source_url" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_sms_consent_log_phone" ON "sms_consent_log" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_sms_consent_log_contact_id" ON "sms_consent_log" USING btree ("contact_id") WHERE "sms_consent_log"."contact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sms_consent_log_created_at" ON "sms_consent_log" USING btree ("created_at" DESC NULLS LAST);