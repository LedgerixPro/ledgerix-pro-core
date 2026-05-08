import { and, eq, ne } from "drizzle-orm";
import { agents, issues } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "../issue-assignment-wakeup.js";

interface InvokeAgentParams {
  heartbeat: IssueAssignmentWakeupDeps;
  companyId: string;
  targetAgentName: string;
  eventType: string;
  contactId: string;
  locationId: string;
  rawPayload: Record<string, unknown>;
}

export interface InvokeAgentResult {
  issued: boolean;
  issueId?: string;
  reason?: string;
}

export function agentBridgeService(db: Db) {
  async function invokeAgentForGhlEvent(params: InvokeAgentParams): Promise<InvokeAgentResult> {
    const { heartbeat, companyId, targetAgentName, eventType, contactId, locationId, rawPayload } = params;

    // Guard: contactId is required to scope the issue and build a dedup key
    if (!contactId) {
      logger.warn({ eventType, locationId }, "GHL bridge: missing contactId, skipping invocation");
      return { issued: false, reason: "missing contactId" };
    }

    // Look up agent by name within the company
    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, targetAgentName), ne(agents.status, "archived")))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      logger.warn({ companyId, targetAgentName }, "GHL bridge: target agent not found");
      return { issued: false, reason: "agent not found" };
    }

    // Idempotency — skip if an issue for this event+contact already exists
    const originId = `ghl-webhook:${eventType}:${contactId}`;
    const existing = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "webhook"), eq(issues.originId, originId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (existing) {
      logger.info({ companyId, originId, issueId: existing.id }, "GHL bridge: duplicate webhook event, skipping");
      return { issued: false, reason: "duplicate" };
    }

    // Build issue title and structured description
    const title = `GHL ${eventType}: ${contactId}`;
    const context = {
      event: eventType,
      contactId,
      locationId,
      receivedAt: new Date().toISOString(),
      payload: rawPayload,
    };
    const description = "```json\n" + JSON.stringify(context, null, 2) + "\n```";

    // Create the issue — status must be 'todo' (not 'backlog') for the wakeup to fire
    const issuesSvc = issueService(db);
    const createdIssue = await issuesSvc.create(companyId, {
      title,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agent.id,
      originKind: "webhook",
      originId,
    });

    // Queue the agent wakeup
    await queueIssueAssignmentWakeup({
      heartbeat,
      issue: { id: createdIssue.id, assigneeAgentId: agent.id, status: "todo" },
      reason: `GHL ${eventType} webhook received`,
      mutation: "issue.created",
      contextSource: "ghl-webhook",
      requestedByActorType: "system",
    });

    logger.info(
      { issueId: createdIssue.id, agentId: agent.id, agentName: targetAgentName, eventType, contactId },
      "GHL bridge: issue created and agent wakeup queued",
    );

    return { issued: true, issueId: createdIssue.id };
  }

  return { invokeAgentForGhlEvent };
}
