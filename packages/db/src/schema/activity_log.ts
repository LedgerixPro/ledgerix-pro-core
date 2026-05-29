import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable to support system-scoped operations (e.g., admin endpoints
    // for safety-layer canonical data management — Phase 4c.5 Decision B,
    // 2026-05-24). Company-scoped operations continue to pass a valid
    // company UUID; system-scoped operations pass NULL.
    companyId: uuid("company_id").references(() => companies.id),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id),
    // Point-in-time identity snapshots (Phase 6 Decision S, 2026-05-29).
    // Captured at write time by logActivity so the audit row remains
    // legible after the live company/agent entity is deleted —
    // litigation-grade audit per ADR-005-successor (Phase 6 arc). Nullable:
    // system-scoped rows have no company/agent, and historical rows
    // pre-dating Decision S have no snapshot.
    companyNameSnapshot: text("company_name_snapshot"),
    agentNameSnapshot: text("agent_name_snapshot"),
    runId: uuid("run_id").references(() => heartbeatRuns.id),
    details: jsonb("details").$type<Record<string, unknown>>(),
    // Outcome of the action being logged. 'success' for completed writes,
    // 'failure' for attempts that failed (validation, upstream errors, etc).
    // Existing rows default to 'success' on backfill. Added Phase 4b for
    // write endpoint audit logging per PHASE-4-ACCOUNTING-API-SPEC Section 2B.1.
    status: text("status").notNull().default("success"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
  }),
);
