CREATE TABLE "client_charter_status" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" text NOT NULL,
	"ghl_contact_id" text NOT NULL,
	"granted_at" timestamp with time zone,
	"status" text NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_charter_status_company_contact_uniq" UNIQUE("company_id","ghl_contact_id")
);
