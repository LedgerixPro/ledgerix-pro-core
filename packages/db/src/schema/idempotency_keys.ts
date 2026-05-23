import { pgTable, uuid, text, timestamp, integer, jsonb, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Tracks Idempotency-Key headers used on write endpoints to support safe
// replay of duplicate requests. See PHASE-4-ACCOUNTING-API-SPEC Section 2B.1.
//
// Behavior:
// - Same (company_id, key) + same request_hash within window: replay original
//   response with HTTP 200 OK and meta.idempotencyReplay = true.
// - Same (company_id, key) + different request_hash within window: 409 Conflict.
// - Same (company_id, key) outside window: treated as a new request.
//
// Window is 24 hours from first use (created_at). expires_at is set explicitly
// on insert so cleanup jobs can rely on a single column.
//
// Storage of response_body is bounded by the size of typical write responses
// (a few KB max — entity ID, status, audit log ID). We store it as JSONB for
// query-time access (e.g. for inspection in the dashboard) but never index
// into its fields.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    key: text("key").notNull(),
    // SHA-256 hex of the canonicalized request body. Two requests with the
    // same Idempotency-Key but different body hashes signal a client bug
    // (or, more rarely, a malicious replay attempt) and trigger 409 Conflict.
    requestHash: text("request_hash").notNull(),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>().notNull(),
    responseStatus: integer("response_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // Primary lookup: find an existing entry by (company, key). Uniqueness
    // enforced at the database level so concurrent requests with the same
    // key can't both create rows.
    companyKeyUnique: unique("idempotency_keys_company_key_unique").on(table.companyId, table.key),
    // Index for the cleanup job that purges expired rows.
    expiresAtIdx: index("idempotency_keys_expires_at_idx").on(table.expiresAt),
  }),
);
