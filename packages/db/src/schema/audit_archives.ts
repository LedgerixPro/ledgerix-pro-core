import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";

// Phase 6 6a-rest FF1/II1 (2026-05-29): manifest table that indexes a deleted
// tenant's archived audit trail.
//
// NOTE (II1): companyId is intentionally a PLAIN uuid with NO
// .references(companies.id). This table is the INDEX to a DELETED tenant's
// archived audit trail — it must OUTLIVE the company row it points at. A FK
// would either block the company delete (ON DELETE NO ACTION) or, if
// cascaded, delete this row itself — both of which defeat the manifest's
// entire purpose. The missing FK is deliberate, not an oversight. Any future
// reviewer tempted to "fix" the missing FK should read the Phase 6 WIP doc
// (or its successor ADR) Decision II1 before changing this.
//
// Writer: companies.remove() — between archiveActivityForCompany() and the
// existing delete transaction (Phase 6 KK1). Skipped for empty archives
// (JJ1: objectKey === null → no row written).
export const auditArchives = pgTable(
  "audit_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull(), // II1: plain — no FK, see note above
    objectKey: text("object_key").notNull(),
    rowCount: integer("row_count").notNull(),
    sha256: text("sha256"),
    windowFrom: timestamp("window_from", { withTimezone: true }),
    windowTo: timestamp("window_to", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("audit_archives_company_idx").on(table.companyId, table.archivedAt),
  }),
);
