import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";

// Charter status lifecycle for each Ledgerix Pro client. Per Q1 of the
// Phase 4c.5 WIP doc (LOCKED 2026-05-27 commit 0cf679d6) and Trust Tenet
// #14: billing is the primary client-funds touchpoint, so Charter status —
// which determines whether the client pays Charter-rate or Standard-rate
// monthly pricing per EA Section 7.1 — has source-of-truth in our own DB.
//
// EA Section 7.1 rules (now structurally enforced via the status enum):
//   1. Charter applies to the first 10 paying clients only.
//   2. Charter benefit follows the client across tier upgrades AND
//      downgrades for as long as service is continuous.
//   3. Charter is permanently lost on cancellation. A returning client
//      is Standard regardless of when they originally became Charter.
//   4. Charter is not transferable, sellable, or recoverable.
//
// Status enum semantics:
//   - "active": client is currently a Charter member (rule 1+2 apply)
//   - "cancelled_was_charter": client was Charter, then cancelled.
//     Rule 3 applied — they cannot return to active. Even if they sign
//     up for service again, a new row with status="never_charter"
//     would be created.
//   - "never_charter": client never qualified for Charter (signed up
//     after the first 10), OR client is a returning ex-Charter client
//     who forfeited per rule 3.
//
// State transitions (enforced at the service layer in charter.ts):
//   - new row on client onboarding: "active" (if among first 10 paying)
//     OR "never_charter" (everyone else)
//   - "active" → "cancelled_was_charter" (one-way, on cancellation)
//   - "cancelled_was_charter" → "active" : FORBIDDEN per rule 3
//   - "never_charter" → "active" : FORBIDDEN per rule 1 (no retroactive
//     grants once the window closes)
//
// One row per (companyId, ghlContactId) — uniqueness constraint enforces
// this so a client cannot have two charter rows.
export const clientCharterStatus = pgTable(
  "client_charter_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // companyId — Ledgerix Pro tenancy. FK-style reference but text-typed
    // for consistency with other accounting-domain tables.
    companyId: text("company_id").notNull(),
    // GHL contact ID — string because GHL uses non-UUID identifiers. Not
    // an FK (we don't have a local GHL contacts mirror table). Same pattern
    // as client_pricing_overrides.ghl_contact_id.
    ghlContactId: text("ghl_contact_id").notNull(),
    // When Charter was first granted to this client. NULL when status is
    // "never_charter" (the client was never granted Charter).
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    // Current status. See JSDoc above for enum semantics.
    status: text("status").notNull(), // "active" | "cancelled_was_charter" | "never_charter"
    // When the status last changed (for audit).
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }).notNull().defaultNow(),
    // When the client cancelled (set only when transitioning active →
    // cancelled_was_charter). NULL for active or never_charter rows.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Free-text reason for the current status. Optional but recommended
    // for cancellation events (so audit reviewers know WHY).
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // One row per client. Enforces "a client cannot have two charter rows."
    uniqCompanyContact: unique("client_charter_status_company_contact_uniq").on(
      table.companyId,
      table.ghlContactId,
    ),
    // Lookup index for the primary read pattern from isCharterForInvoicing:
    // WHERE company_id=? AND ghl_contact_id=? — already covered by the
    // unique constraint, so no additional explicit index needed.
  }),
);
