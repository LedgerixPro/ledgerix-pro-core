CREATE TABLE "client_pricing_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"tier" text NOT NULL,
	"monthly_amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"approved_by_user_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_tier_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tier" text NOT NULL,
	"is_charter" boolean NOT NULL,
	"monthly_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "client_pricing_overrides_contact_tier_idx" ON "client_pricing_overrides" USING btree ("ghl_contact_id","tier");--> statement-breakpoint
CREATE INDEX "service_tier_pricing_tier_charter_idx" ON "service_tier_pricing" USING btree ("tier","is_charter");