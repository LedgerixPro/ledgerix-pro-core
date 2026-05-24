import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// Per-endpoint write thresholds for Phase 4c safety architecture per ADR-003 Q8.
//
// Each row defines a threshold that triggers an approval requirement when
// exceeded. Thresholds are hierarchical:
//   1. Per-client per-endpoint (most specific) — ghlContactId NOT NULL
//   2. Per-endpoint global default — ghlContactId NULL
//
// Per-client overrides override global defaults for the same endpoint+field.
// Multiple thresholds per endpoint+contactId combination are allowed if they
// check different fields (e.g., amount AND vendor-credit AND duplicate-flag).
//
// "Active" means effective_to IS NULL. Historical thresholds preserved as
// rows with effective_to set. New thresholds ship as new rows; the previous
// row's effective_to is set to the new row's effective_from.
//
// Bootstrap data (deferred to 4c.2b runbook):
//   Global: accounting.payments / amount / gt / 1000000 (= $10K)
//   Global: accounting.invoices / lineItems.sum / gt / 100000 (= $1K)
// Source: EA v3.3 Section 6.3 — "Payroll runs >$10,000 — CFO must sign off"
// and conservative invoice anomaly detection.
export const writeThresholds = pgTable(
  "write_thresholds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // GHL contact ID. NULL means "global default" — applies to all clients
    // unless overridden by a per-client row.
    ghlContactId: text("ghl_contact_id"),
    // Endpoint identifier in dot-namespaced form. Matches the approval-type
    // prefix from ADR-003 Q1 (e.g., "accounting.payments",
    // "accounting.invoices", "accounting.transactions.category").
    endpoint: text("endpoint").notNull(),
    // Field on the request body being checked. Free-form string so future
    // thresholds can target any field (e.g., "amount", "lineItems.sum",
    // "lineItems.count", etc.). Validated at call-site, not by the schema.
    field: text("field").notNull(),
    // Comparison operator. Constrained to "gt" or "gte" at app level.
    comparator: text("comparator").notNull(),
    // Threshold value. For monetary fields stored in cents. For count
    // fields (e.g., lineItems.count) stored as integer count. Caller knows
    // the unit by inspecting the field name.
    thresholdValue: integer("threshold_value").notNull(),
    // What happens when threshold is exceeded. Currently only "require_approval"
    // is implemented. Future: "deny" (reject the write entirely), "warn"
    // (proceed with logged warning). Constrained at app level.
    action: text("action").notNull().default("require_approval"),
    // Human-readable description. Mandatory — silent thresholds are tenet
    // violations. Shown to approvers and in audit logs.
    reason: text("reason").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    // NULL = currently active.
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Primary lookup: WHERE endpoint=? AND (ghl_contact_id=? OR ghl_contact_id IS NULL)
    // AND effective_to IS NULL
    endpointContactIdx: index("write_thresholds_endpoint_contact_idx").on(table.endpoint, table.ghlContactId),
  }),
);
