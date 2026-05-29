import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { publishLiveEvent } from "./live-events.js";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";
import { instanceSettingsService } from "./instance-settings.js";

const PLUGIN_EVENT_SET: ReadonlySet<string> = new Set(PLUGIN_EVENT_TYPES);
const ACTIVITY_ACTION_TO_PLUGIN_EVENT: Readonly<Record<string, PluginEventType>> = {
  issue_comment_added: "issue.comment.created",
  issue_comment_created: "issue.comment.created",
  issue_document_created: "issue.document.created",
  issue_document_updated: "issue.document.updated",
  issue_document_deleted: "issue.document.deleted",
  issue_blockers_updated: "issue.relations.updated",
  approval_approved: "approval.decided",
  approval_rejected: "approval.decided",
  approval_revision_requested: "approval.decided",
  budget_soft_threshold_crossed: "budget.incident.opened",
  budget_hard_threshold_crossed: "budget.incident.opened",
  budget_incident_resolved: "budget.incident.resolved",
};

let _pluginEventBus: PluginEventBus | null = null;

/** Wire the plugin event bus so domain events are forwarded to plugins. */
export function setPluginEventBus(bus: PluginEventBus): void {
  if (_pluginEventBus) {
    logger.warn("setPluginEventBus called more than once, replacing existing bus");
  }
  _pluginEventBus = bus;
}

function eventTypeForActivityAction(action: string): PluginEventType | null {
  if (PLUGIN_EVENT_SET.has(action)) return action as PluginEventType;
  return ACTIVITY_ACTION_TO_PLUGIN_EVENT[action.replaceAll(".", "_")] ?? null;
}

export function publishPluginDomainEvent(event: PluginEvent): void {
  if (!_pluginEventBus) return;
  void _pluginEventBus.emit(event).then(({ errors }) => {
    for (const { pluginId, error } of errors) {
      logger.warn({ pluginId, eventType: event.eventType, err: error }, "plugin event handler failed");
    }
  }).catch(() => {});
}

export type ActivityStatus = "success" | "failure";

export interface LogActivityInput {
  // Nullable per Phase 4c.5 Decision B (2026-05-24): system-scoped admin
  // operations (e.g., POST /api/admin/pricing/seed) pass NULL since they
  // don't belong to any specific company. Company-scoped operations
  // continue to pass a valid company UUID.
  companyId: string | null;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId?: string | null;
  // Point-in-time identity per Phase 6 Decision S / Decision T (REVISED).
  // Supplied by the accounting write paths (litigation-defense-of-books
  // surface — low volume, callers do the resolve). Omitted → stored null.
  // logActivity does NOT look these up: NO added query on the hot path
  // (the general 142-site surface stores null snapshots).
  companyNameSnapshot?: string | null;
  agentNameSnapshot?: string | null;
  runId?: string | null;
  details?: Record<string, unknown> | null;
  // Outcome of the action. Defaults to "success" if omitted, preserving
  // backward compat with all pre-Phase-4b callers (who only logged successes).
  // Phase 4b write endpoints set this explicitly to "failure" when logging
  // attempts that did not complete (validation errors, upstream rejections).
  status?: ActivityStatus;
}

export async function logActivity(db: Db, input: LogActivityInput): Promise<{ id: string }> {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  const status: ActivityStatus = input.status ?? "success";
  const inserted = await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    companyNameSnapshot: input.companyNameSnapshot ?? null,
    agentNameSnapshot: input.agentNameSnapshot ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
    status,
  }).returning({ id: activityLog.id });

  // System-scoped operations (companyId === null) don't broadcast live events.
  // The DB row is preserved as the durable audit record. Per Phase 4c.5
  // Decision B + Option 1 (locked 2026-05-24): admin operations don't have
  // a target company audience for real-time updates. Activity_log query
  // remains the source of truth for system-scoped operations.
  if (input.companyId !== null) {
    publishLiveEvent({
      companyId: input.companyId,
      type: "activity.logged",
      payload: {
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        details: redactedDetails,
        status,
      },
    });
  }

  // System-scoped operations don't emit plugin events for the same reason
  // as live-events: no company-scoped audience. Per Phase 4c.5 Option 1.
  const pluginEventType = input.companyId !== null ? eventTypeForActivityAction(input.action) : null;
  if (pluginEventType && input.companyId !== null) {
    const event: PluginEvent = {
      eventId: randomUUID(),
      eventType: pluginEventType,
      occurredAt: new Date().toISOString(),
      actorId: input.actorId,
      actorType: input.actorType,
      entityId: input.entityId,
      entityType: input.entityType,
      companyId: input.companyId,
      payload: {
        ...redactedDetails,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        status,
      },
    };
    publishPluginDomainEvent(event);
  }

  return { id: inserted[0].id };
}
