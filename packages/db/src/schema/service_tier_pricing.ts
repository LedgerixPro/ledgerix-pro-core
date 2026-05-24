import { pgTable, uuid, text, integer, timestamp, boolean, index, unique } from "drizzle-orm/pg-core";

// Canonical pricing for each service tier (Foundation / Growth Engine /
// Scale-Up) at both Charter and Standard rates. Per ADR-003 Q6, pricing
// lives in the database (not constants or GHL) so prices can change without
// code deploys and per-client overrides have a clean architectural home
// (see client_pricing_overrides).
//
// Each row represents the price for a specific (tier, isCharter) combination
// at a point in time. Historical pricing is preserved via effective_from /
// effective_to columns rather than UPDATE-in-place. The currently-active
// row for a (tier, isCharter) has effective_to = NULL.
//
// Bootstrap data ships in a seed migration: 6 canonical rows reflecting
// EA Section 7.1 pricing:
//   Foundation Charter $199, Standard $299
//   Growth Engine Charter $399, Standard $499
//   Scale-Up Charter $799, Standard $899
export const serviceTierPricing = pgTable(
  "service_tier_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tier name. Constrained to the three known values via app-level validation;
    // not enforced via PostgreSQL enum to keep migrations simple if we add a tier.
    tier: text("tier").notNull(),
    // True for Charter pricing (first 10 clients), false for Standard.
    isCharter: boolean("is_charter").notNull(),
    // Amount in cents to avoid floating-point. $199.00 = 19900.
    monthlyAmountCents: integer("monthly_amount_cents").notNull(),
    // Currency code. USD only for v1; column exists for future expansion.
    currency: text("currency").notNull().default("USD"),
    // When this price became effective. Defaults to now for newly inserted rows.
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    // NULL = currently active. A new row gets inserted (not UPDATE) when prices change;
    // the previous row's effective_to is set to the new row's effective_from.
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Look up active prices quickly: WHERE tier=? AND is_charter=? AND effective_to IS NULL
    tierCharterIdx: index("service_tier_pricing_tier_charter_idx").on(table.tier, table.isCharter),
  }),
);
