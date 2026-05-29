import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const legalHolds = pgTable(
  "legal_holds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    reason: text("reason").notNull(),
    placedByUserId: text("placed_by_user_id"),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedByUserId: text("lifted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyActiveIdx: index("legal_holds_company_active_idx").on(table.companyId, table.liftedAt),
  }),
);
