import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { agents, issues, accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghl, ghlRequest, getFieldValue } from "../services/ghl/index.js";
import type { GHLContact, GHLContactSearchResult } from "../services/ghl/index.js";

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";
const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";

// ---------------------------------------------------------------------------
// Auth — shared-secret header, constant-time compare
// ---------------------------------------------------------------------------

function requireDashboardSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.DASHBOARD_SECRET;
  if (!expected) {
    logger.warn("DASHBOARD_SECRET is not set; rejecting dashboard request");
    res.status(500).json({ error: "Dashboard secret not configured" });
    return;
  }
  const provided = req.get("x-dashboard-secret");
  if (!provided) {
    res.status(401).json({ error: "Missing x-dashboard-secret header" });
    return;
  }
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    res.status(401).json({ error: "Invalid dashboard secret" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function sevenDaysAgoUtc(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

function fullName(c: GHLContact): string {
  return `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim();
}

async function fetchActiveClients(): Promise<GHLContact[]> {
  // GHL's /contacts endpoint rejects the `tags` query parameter (422). Fetch
  // the contact list for this location and filter in memory by the
  // `client-active` tag. Fine at current scale; revisit at ~100 contacts.
  const params = new URLSearchParams({ locationId: LOCATION_ID });
  const res = await ghlRequest<GHLContactSearchResult>("GET", `/contacts/?${params}`);
  return (res.contacts ?? []).filter((c) => Array.isArray(c.tags) && c.tags.includes("client-active"));
}

async function platformForWorkspace(db: Db, clientCompanyId: string): Promise<string | null> {
  const row = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(eq(accountingConnections.companyId, clientCompanyId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row?.platform ?? null;
}

// Safely read a numeric field out of a runMetrics jsonb blob
function num(metrics: unknown, key: string): number | null {
  if (metrics && typeof metrics === "object" && key in (metrics as Record<string, unknown>)) {
    const v = (metrics as Record<string, unknown>)[key];
    return typeof v === "number" ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function ledgerixDashboardRoutes(db: Db) {
  const router = Router();

  router.use("/dashboard", requireDashboardSecret);

  // ---- GET /dashboard/summary ---------------------------------------------
  router.get("/dashboard/summary", async (_req, res) => {
    try {
    // postgres driver rejects Date objects as bind params — pass ISO string
    const todayStartIso = startOfTodayUtc().toISOString();

    const [contacts, seniorBookkeeper, ledgerSpecialist, reconciliationAgent] = await Promise.all([
      fetchActiveClients(),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.name, "Senior Bookkeeper")))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.name, "Ledger Specialist")))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.name, "Reconciliation Agent")))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const todayStart = startOfTodayUtc();

    // Per-client summary. Issues are stored under the Ledgerix Pro company; we
    // associate them with clients by matching the contact's full name in the
    // issue title. Brittle but acceptable at current scale (~5-20 clients).
    // Per-client metrics come from issues.run_metrics on the latest done run
    // by each agent today (item 39).
    const clients = await Promise.all(
      contacts.map(async (contact) => {
        const contactName = fullName(contact);
        const workspaceId = getFieldValue(contact, "ledgerix_workspace_id");
        const serviceTier = getFieldValue(contact, "service_tier");

        const platform = typeof workspaceId === "string" && workspaceId
          ? await platformForWorkspace(db, workspaceId)
          : null;

        const titlePattern = `%${contactName}%`;

        const [lastRunRow, openHitlRow, ledgerRunRow, reconcilRunRow] = await Promise.all([
          db
            .select({ completedAt: sql<Date | null>`MAX(${issues.completedAt})` })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, COMPANY_ID),
                contactName ? sql`${issues.title} ILIKE ${titlePattern}` : sql`FALSE`,
              ),
            )
            .then((rows) => rows[0] ?? null),
          seniorBookkeeper && contactName
            ? db
                .select({ count: sql<number>`COUNT(*)::int` })
                .from(issues)
                .where(
                  and(
                    eq(issues.assigneeAgentId, seniorBookkeeper.id),
                    inArray(issues.status, ["todo", "in_progress", "blocked"]),
                    sql`${issues.title} ILIKE ${titlePattern}`,
                  ),
                )
                .then((rows) => rows[0] ?? null)
            : Promise.resolve(null),
          ledgerSpecialist && contactName
            ? db
                .select({ runMetrics: issues.runMetrics })
                .from(issues)
                .where(
                  and(
                    eq(issues.assigneeAgentId, ledgerSpecialist.id),
                    eq(issues.status, "done"),
                    gte(issues.completedAt, todayStart),
                    sql`${issues.title} ILIKE ${titlePattern}`,
                  ),
                )
                .orderBy(desc(issues.completedAt))
                .limit(1)
                .then((rows) => rows[0] ?? null)
            : Promise.resolve(null),
          reconciliationAgent && contactName
            ? db
                .select({ runMetrics: issues.runMetrics })
                .from(issues)
                .where(
                  and(
                    eq(issues.assigneeAgentId, reconciliationAgent.id),
                    eq(issues.status, "done"),
                    gte(issues.completedAt, todayStart),
                    sql`${issues.title} ILIKE ${titlePattern}`,
                  ),
                )
                .orderBy(desc(issues.completedAt))
                .limit(1)
                .then((rows) => rows[0] ?? null)
            : Promise.resolve(null),
        ]);

        const ledgerMetrics = ledgerRunRow?.runMetrics ?? null;
        const reconcilMetrics = reconcilRunRow?.runMetrics ?? null;

        return {
          contactId: contact.id,
          contactName,
          // companyName isn't in the GHLContact type stub but GHL returns it
          companyName: (contact as { companyName?: string }).companyName ?? null,
          serviceTier: typeof serviceTier === "string" ? serviceTier : null,
          platform,
          lastRunAt: lastRunRow?.completedAt ?? null,
          transactionsToday: num(ledgerMetrics, "transactionsProcessed"),
          autoCategorized: num(ledgerMetrics, "autoCategorized"),
          // flagged stays SQL-counted (open SB issues for this client) — that's
          // "currently pending review", more useful than "flagged today"
          flagged: openHitlRow?.count ?? 0,
          reconciled: num(reconcilMetrics, "autoReconciled"),
          hitlPending: (openHitlRow?.count ?? 0) > 0,
        };
      }),
    );

    // HITL queue — every open Senior Bookkeeper issue across all clients
    const hitlQueue = seniorBookkeeper
      ? await db
          .select({
            issueId: issues.id,
            title: issues.title,
            priority: issues.priority,
            createdAt: issues.createdAt,
            agentName: agents.name,
          })
          .from(issues)
          .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
          .where(
            and(
              eq(issues.companyId, COMPANY_ID),
              eq(agents.name, "Senior Bookkeeper"),
              eq(issues.status, "todo"),
            ),
          )
          .orderBy(issues.createdAt)
          .then((rows) =>
            rows.map((r) => {
              // Best-effort contactName extraction from "Title — {contactName} — ..." pattern
              const parts = r.title.split(" — ");
              const contactName = parts.length >= 2 ? parts[1] : null;
              const ageHours = Math.floor(
                (Date.now() - new Date(r.createdAt).getTime()) / (60 * 60 * 1000),
              );
              return {
                issueId: r.issueId,
                title: r.title,
                contactName,
                agentName: r.agentName,
                priority: r.priority,
                createdAt: r.createdAt,
                ageHours,
              };
            }),
          )
      : [];

    // Agent health — per-agent counts across the Ledgerix Pro company
    const agentHealthRows = await db
      .select({
        agentName: agents.name,
        lastRunAt: sql<Date | null>`MAX(${issues.completedAt})`,
        runsToday: sql<number>`COUNT(*) FILTER (WHERE ${issues.createdAt} >= ${todayStartIso})::int`,
        timeoutCount: sql<number>`COUNT(*) FILTER (WHERE ${issues.status} = 'blocked')::int`,
        issuesOpen: sql<number>`COUNT(*) FILTER (WHERE ${issues.status} IN ('todo', 'in_progress'))::int`,
        issuesDone: sql<number>`COUNT(*) FILTER (WHERE ${issues.status} = 'done')::int`,
      })
      .from(agents)
      .leftJoin(issues, eq(issues.assigneeAgentId, agents.id))
      .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.adapterType, "claude_local")))
      .groupBy(agents.id, agents.name)
      .orderBy(agents.name);

    const agentHealth = agentHealthRows.map((row) => ({
      agentName: row.agentName,
      lastRunAt: row.lastRunAt,
      runsToday: row.runsToday,
      timeoutCount: row.timeoutCount,
      issuesOpen: row.issuesOpen,
      issuesDone: row.issuesDone,
      status: row.timeoutCount > 0 ? "degraded" : row.issuesOpen > 0 ? "active" : "idle",
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      clients,
      hitlQueue,
      agentHealth,
    });
    } catch (err) {
      logger.error({ err }, "Dashboard summary failed");
      res.status(500).json({
        error: "Dashboard summary failed",
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 6) : undefined,
      });
    }
  });

  // ---- GET /dashboard/agent/:agentName ------------------------------------
  router.get("/dashboard/agent/:agentName", async (req, res) => {
    const agentName = decodeURIComponent(req.params.agentName as string);

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, COMPANY_ID), eq(agents.name, agentName)))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!agent) {
      res.status(404).json({ error: `Agent not found: ${agentName}` });
      return;
    }

    const since = sevenDaysAgoUtc();
    const recent = await db
      .select({
        title: issues.title,
        status: issues.status,
        createdAt: issues.createdAt,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
      })
      .from(issues)
      .where(and(eq(issues.assigneeAgentId, agent.id), gte(issues.createdAt, since)))
      .orderBy(desc(issues.createdAt));

    const issuesLast7Days = recent.map((i) => {
      const durationMs =
        i.startedAt && i.completedAt
          ? new Date(i.completedAt).getTime() - new Date(i.startedAt).getTime()
          : null;
      return {
        title: i.title,
        status: i.status,
        createdAt: i.createdAt,
        completedAt: i.completedAt,
        durationMs,
      };
    });

    const timeoutCount7Days = recent.filter((i) => i.status === "blocked").length;
    const completedDurations = issuesLast7Days
      .map((i) => i.durationMs)
      .filter((d): d is number => d != null);
    const avgDurationMs =
      completedDurations.length > 0
        ? Math.round(completedDurations.reduce((s, d) => s + d, 0) / completedDurations.length)
        : null;
    const errorRate = recent.length > 0 ? timeoutCount7Days / recent.length : 0;

    res.json({
      agentName,
      issuesLast7Days,
      timeoutCount7Days,
      avgDurationMs,
      errorRate,
    });
  });

  return router;
}
