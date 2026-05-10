DROP INDEX "accounting_connections_company_platform_idx";--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD COLUMN "contact_id" text;--> statement-breakpoint
ALTER TABLE "accounting_connections" ADD CONSTRAINT "accounting_connections_company_platform_contact_uq" UNIQUE NULLS NOT DISTINCT("company_id","platform","contact_id");