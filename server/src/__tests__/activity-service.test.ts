import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type ActivityService = ReturnType<typeof activityService>;
type IssueRun = Awaited<ReturnType<ActivityService["runsForIssue"]>>[number];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIssueRun(
  service: ActivityService,
  companyId: string,
  issueId: string,
  predicate: (run: IssueRun) => boolean,
) {
  const deadline = Date.now() + 2_000;
  let latestRuns: IssueRun[] = [];
  while (Date.now() < deadline) {
    latestRuns = await service.runsForIssue(companyId, issueId);
    const run = latestRuns.find(predicate);
    if (run) return { run, runs: latestRuns };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for issue run. Latest run count: ${latestRuns.length}`);
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns compact usage and result summaries for issue runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot: { issueId },
      usageJson: {
        inputTokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        billingType: "metered",
        costUsd: 0.42,
        enormousBlob: "x".repeat(256_000),
      },
      resultJson: {
        billing_type: "metered",
        total_cost_usd: 0.42,
        stopReason: "timeout",
        effectiveTimeoutSec: 30,
        timeoutFired: true,
        summary: "done",
        nestedHuge: { payload: "y".repeat(256_000) },
      },
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });

    const runs = await activityService(db).runsForIssue(companyId, issueId);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      agentId,
      invocationSource: "assignment",
    });
    expect(runs[0]?.usageJson).toEqual({
      inputTokens: 11,
      input_tokens: 11,
      outputTokens: 7,
      output_tokens: 7,
      cachedInputTokens: 3,
      cached_input_tokens: 3,
      cache_read_input_tokens: 3,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
    });
    expect(runs[0]?.resultJson).toEqual({
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutFired: true,
    });
    expect(runs[0]).toMatchObject({
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });
  });

  it("backfills missing liveness for completed issue runs before returning the ledger", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const completedAt = new Date("2026-04-18T20:04:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:00:00.000Z"),
      finishedAt: completedAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Finished the implementation.",
      },
      livenessState: null,
      livenessReason: null,
      lastUsefulActionAt: null,
      nextAction: null,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Done",
      createdAt: completedAt,
    });

    const service = activityService(db);
    const { run, runs } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "completed",
    );

    expect(runs).toHaveLength(1);
    expect(run).toMatchObject({
      runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });

    const [persisted] = await db.select().from(heartbeatRuns);
    expect(persisted).toMatchObject({
      id: runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });
  });

  it("does not backfill document evidence from a different run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:08:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:00:00.000Z"),
        finishedAt: new Date("2026-04-18T20:02:00.000Z"),
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Next steps:\n- inspect files",
        },
        livenessState: null,
        livenessReason: null,
      },
      {
        id: otherRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:05:00.000Z"),
        finishedAt: createdAt,
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Updated the plan document.",
        },
        livenessState: "advanced",
        livenessReason: "Run produced concrete action evidence: 1 document revision(s)",
      },
    ]);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan\n\n- Inspect files",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n- Inspect files",
      createdByAgentId: agentId,
      createdByRunId: otherRunId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("does not treat continuation summary revisions as concrete backfill evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:12:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:10:00.000Z"),
      finishedAt: createdAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Next steps:\n- inspect files",
      },
      livenessState: null,
      livenessReason: null,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Continuation Summary",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Continuation Summary",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });
});

// ============================================================================
// Phase 6 6a-rest-QUERY: retrieveAuditTrail (GG1/LL1/MM1).
// Live → activity_log; deleted+manifest → readArchive (all manifests, merged);
// neither → empty (NOT 404). Driven by real flows (companies.remove() for the
// archived path) to exercise the actual production seam.
// ============================================================================

describeEmbeddedPostgres("activityService.retrieveAuditTrail", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-audit-retrieval-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("LIVE: company exists + activity_log rows → source 'live', rows in chronological asc order, ArchivedActivityRow shape", async () => {
    const { activityLog, companies, auditArchives } = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Live Tenant",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        id: randomUUID(),
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "accounting.write.success",
        entityType: "accounting_write",
        entityId: "txn-1",
        agentId: null,
        runId: null,
        details: { foo: "bar" },
        status: "success",
        companyNameSnapshot: "Live Tenant",
        agentNameSnapshot: "Recon Agent",
        createdAt: new Date("2026-05-29T10:00:00.000Z"),
      },
      {
        id: randomUUID(),
        companyId,
        actorType: "agent",
        actorId: "agent-1",
        action: "accounting.write.success",
        entityType: "accounting_write",
        entityId: "txn-2",
        agentId: null,
        runId: null,
        details: null,
        status: "success",
        companyNameSnapshot: null,
        agentNameSnapshot: null,
        createdAt: new Date("2026-05-29T11:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).retrieveAuditTrail(companyId);

    expect(result.source).toBe("live");
    expect(result.rows).toHaveLength(2);
    // Chronological asc.
    expect(result.rows[0].entityId).toBe("txn-1");
    expect(result.rows[1].entityId).toBe("txn-2");
    // createdAt → ISO string (matches archived path's JSON-round-tripped shape).
    expect(result.rows[0].createdAt).toBe("2026-05-29T10:00:00.000Z");
    expect(result.rows[1].createdAt).toBe("2026-05-29T11:00:00.000Z");
    // Snapshot fields carried through.
    expect(result.rows[0].companyNameSnapshot).toBe("Live Tenant");
    expect(result.rows[1].companyNameSnapshot).toBeNull();

    // Cleanup
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await db.delete(auditArchives).where(eq(auditArchives.companyId, companyId));
  });

  it("ARCHIVED: company removed via real flow → source 'archived', rows readArchive'd via the manifest", async () => {
    const { activityLog, companies, auditArchives } = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Departed Tenant",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "accounting.write.success",
      entityType: "accounting_write",
      entityId: "archived-txn-1",
      agentId: null,
      runId: null,
      details: { note: "before deletion" },
      status: "success",
      companyNameSnapshot: "Departed Tenant",
      agentNameSnapshot: "Recon Agent",
      createdAt: new Date("2026-05-29T09:00:00.000Z"),
    });

    // Real flow: companies.remove() → archive → manifest insert → cascade.
    await companyService(db).remove(companyId);

    // Company is GONE; manifest row exists; activity_log row is gone.
    const companyAfter = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(companyAfter).toHaveLength(0);
    const manifests = await db.select().from(auditArchives).where(eq(auditArchives.companyId, companyId));
    expect(manifests).toHaveLength(1);

    const result = await activityService(db).retrieveAuditTrail(companyId);

    expect(result.source).toBe("archived");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].entityId).toBe("archived-txn-1");
    expect(result.rows[0].details).toEqual({ note: "before deletion" });
    expect(result.rows[0].companyNameSnapshot).toBe("Departed Tenant");
    expect(result.rows[0].createdAt).toBe("2026-05-29T09:00:00.000Z");

    await db.delete(auditArchives).where(eq(auditArchives.companyId, companyId));
  });

  it("ARCHIVED MULTI (MM1): two manifest rows → readArchive each, merged by createdAt", async () => {
    const { activityLog, companies, auditArchives } = await import("@paperclipai/db");
    const { eq } = await import("drizzle-orm");
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Multi-Manifest Tenant",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: "agent-1",
      action: "accounting.write.success",
      entityType: "accounting_write",
      entityId: "multi-txn-1",
      agentId: null,
      runId: null,
      details: null,
      status: "success",
      companyNameSnapshot: "Multi-Manifest Tenant",
      agentNameSnapshot: null,
      createdAt: new Date("2026-05-29T08:00:00.000Z"),
    });

    // Real archive + manifest via companies.remove().
    await companyService(db).remove(companyId);
    const firstManifest = await db.select().from(auditArchives).where(eq(auditArchives.companyId, companyId));
    expect(firstManifest).toHaveLength(1);

    // Simulate MM1: insert a SECOND manifest row pointing at the same archive
    // object. retrieveAuditTrail must readArchive BOTH and concatenate. (Today
    // a tenant has at most one manifest row; this test guards the merge path
    // against silent-loss bugs if windowed archiving ever produces multiple.)
    await db.insert(auditArchives).values({
      companyId,
      objectKey: firstManifest[0].objectKey,
      rowCount: firstManifest[0].rowCount,
      sha256: firstManifest[0].sha256,
      // archivedAt defaults to now() — sorts after the first manifest row.
    });

    const result = await activityService(db).retrieveAuditTrail(companyId);

    expect(result.source).toBe("archived");
    // Two manifest rows × one row in the archive each = 2 rows in the merged result.
    expect(result.rows).toHaveLength(2);
    // Both rows have the same content (same archive object); the load-bearing
    // assertion is that BOTH manifests were read (not just one).
    expect(result.rows[0].entityId).toBe("multi-txn-1");
    expect(result.rows[1].entityId).toBe("multi-txn-1");

    await db.delete(auditArchives).where(eq(auditArchives.companyId, companyId));
  });

  it("NONE (LL1): company doesn't exist + no manifest rows → source 'none', rows [] (NOT 404)", async () => {
    const companyId = randomUUID();
    const result = await activityService(db).retrieveAuditTrail(companyId);

    expect(result.source).toBe("none");
    expect(result.rows).toEqual([]);
  });
});
