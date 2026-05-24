import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// Per-client pricing overrides for service tiers. Per ADR-003 Q6, this
// captures cases where a specific client has a custom-negotiated price
// that differs from the canonical service_tier_pricing rate for their tier.
//
// Lookup precedence (from getExpectedPriceCents):
//   1. Active override for (ghlContactId, tier) — this table
//   2. Canonical service_tier_pricing for tier + charter/standard
//
// Every override has an explicit reason (so reviewers know WHY this client
// has a custom price) and approval audit (who approved, when). Effective
// dating mirrors service_tier_pricing: new rows for changes, not UPDATE-in-place.
export const clientPricingOverrides = pgTable(
  "client_pricing_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // GHL contact ID — string because GHL uses non-UUID identifiers. Not
    // a foreign key (we don't have a local GHL contacts mirror table).
    ghlContactId: text("ghl_contact_id").notNull(),
    // Tier this override applies to. Same string values as service_tier_pricing.tier.
    tier: text("tier").notNull(),
    // Override amount in cents.
    monthlyAmountCents: integer("monthly_amount_cents").notNull(),
    // Why this override exists. Mandatory — silent overrides are tenet-violations.
    reason: text("reason").notNull(),
    // When the override became effective.
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    // NULL = currently active. New row inserted on change (not UPDATE).
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    // Audit: who approved this override (board user ID). Required.
    approvedByUserId: text("approved_by_user_id").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary lookup: WHERE ghl_contact_id=? AND tier=? AND effective_to IS NULL
    contactTierIdx: index("client_pricing_overrides_contact_tier_idx").on(table.ghlContactId, table.tier),
  }),
);
