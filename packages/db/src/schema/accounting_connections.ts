import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const accountingConnections = pgTable(
  "accounting_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // 'quickbooks' | 'xero'
    contactId: text("contact_id"), // GHL contact ID; nullable for the workspace-level/global connection
    realmId: text("realm_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPlatformContactUq: unique("accounting_connections_company_platform_contact_uq")
      .on(table.companyId, table.platform, table.contactId)
      .nullsNotDistinct(),
  }),
);
