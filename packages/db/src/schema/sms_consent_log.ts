import { pgTable, uuid, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// A2P 10DLC / TCPA audit trail. One row per affirmative SMS consent capture.
// Insert BEFORE the GHL upsert so consent is persisted even if GHL fails.
export const smsConsentLog = pgTable(
  "sms_consent_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // GHL contact ID; nullable because the row is written before the GHL upsert
    // completes. Backfilled once GHL responds with the contact's id.
    contactId: text("contact_id"),
    email: text("email"),
    // The consent is meaningless without a phone number.
    phone: text("phone").notNull(),
    // True = user checked the box. Future-proofed for false events (e.g. STOP
    // replies), though only true rows are inserted today.
    consentGranted: boolean("consent_granted").notNull(),
    // Full snapshot of the exact disclosure text the user agreed to. We store
    // the literal text (not just a pointer) so audits remain valid even if the
    // disclosure copy is later revised.
    consentText: text("consent_text").notNull(),
    // Short identifier for fast filtering (e.g. "v2026-05-11").
    consentTextVersion: text("consent_text_version").notNull(),
    // Where the consent was collected (e.g. https://api.ledgerixpro.com/diagnostic).
    sourceUrl: text("source_url").notNull(),
    // Best-effort capture; may be null behind certain proxies.
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    phoneIdx: index("idx_sms_consent_log_phone").on(table.phone),
    contactIdIdx: index("idx_sms_consent_log_contact_id")
      .on(table.contactId)
      .where(sql`${table.contactId} IS NOT NULL`),
    createdAtIdx: index("idx_sms_consent_log_created_at").on(table.createdAt.desc()),
  }),
);
