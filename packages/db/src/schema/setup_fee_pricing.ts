import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// One-time setup fees per service tier. Per Q2 of the Phase 4c.5 WIP doc
// (LOCKED 2026-05-27 commit 0cf679d6) and EA Section 7: every client pays
// a one-time setup fee at onboarding to cover chart-of-accounts review,
// vendor categorization rules, platform connection, workflow training,
// and (where applicable) data migration.
//
// Architectural separation from service_tier_pricing:
//   - Setup fees do NOT vary by Charter status (EA Section 7: "All clients
//     (including Charter) pay a one-time setup fee at onboarding"). The
//     isCharter dimension that's load-bearing on service_tier_pricing has
//     no meaning here, so this table omits it entirely.
//   - Setup fees do NOT have per-client overrides (locked v1 — if a
//     future business need surfaces, add via REVISED note).
//   - Setup fees ARE effective-dated (same pattern as service_tier_pricing)
//     so future fee changes don't rewrite history.
//
// EA Section 7 canonical values (seeded via POST /api/admin/pricing/seed):
//   Foundation:     $249    = 24900 cents
//   Growth Engine:  $349    = 34900 cents
//   Scale-Up:       $1,200  = 120000 cents
//
// Currently-active row for a tier has effective_to = NULL. Historical fees
// preserved via effective_to set, but those are not used for lookups.
export const setupFeePricing = pgTable(
  "setup_fee_pricing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Tier name. Constrained to the three known values via app-level validation;
    // not enforced via PostgreSQL enum to keep migrations simple if a tier is
    // added. Mirrors service_tier_pricing's display-style convention
    // ("Foundation" / "Growth Engine" / "Scale-Up").
    tier: text("tier").notNull(),
    // Amount in cents to avoid floating-point. $249.00 = 24900.
    amountCents: integer("amount_cents").notNull(),
    // Currency code. USD only for v1; column exists for future expansion.
    currency: text("currency").notNull().default("USD"),
    // When this fee became effective. Defaults to now for newly inserted rows.
    effectiveFrom: timestamp("effective_from", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NULL = currently active. New row inserted (not UPDATE) on change;
    // the previous row's effective_to is set to the new row's effective_from.
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    // Look up active fees quickly: WHERE tier=? AND effective_to IS NULL
    tierIdx: index("setup_fee_pricing_tier_idx").on(table.tier),
  }),
);
