import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
  retrieveAuditTrail: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/activity.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        adapterType: "codex_local",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local" }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-2/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/heartbeat-runs/missing-run/issues");

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Phase 6 6a-rest-QUERY (NN1): board-gated audit-trail retrieval route.
  // CRITICAL: assertBoard ONLY — NOT assertCompanyAccess (would break the
  // core deleted-tenant case).
  // --------------------------------------------------------------------------

  it("NN1: returns the service result for board actors (source + rows)", async () => {
    mockActivityService.retrieveAuditTrail.mockResolvedValue({
      source: "live",
      rows: [{ id: "row-1", action: "x", createdAt: "2026-05-29T10:00:00.000Z" }],
    });

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/audit");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      source: "live",
      rows: [{ id: "row-1", action: "x", createdAt: "2026-05-29T10:00:00.000Z" }],
    });
    expect(mockActivityService.retrieveAuditTrail).toHaveBeenCalledWith("company-1");
  });

  it("NN1: NOT board → 403; service not called", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });
    const res = await request(app).get("/api/companies/company-1/audit");

    expect(res.status).toBe(403);
    expect(mockActivityService.retrieveAuditTrail).not.toHaveBeenCalled();
  });

  it("NN1 GUARD: assertCompanyAccess NOT enforced — board can retrieve a DELETED company's audit (the core case)", async () => {
    // Simulate the deleted-tenant scenario: board actor with companyIds: [] —
    // would fail assertCompanyAccess for any companyId — but the audit route
    // uses assertBoard ONLY, so this MUST succeed. If a future change ever
    // adds assertCompanyAccess to the route, this test flips and the
    // deleted-tenant retrieval path silently breaks.
    mockActivityService.retrieveAuditTrail.mockResolvedValue({
      source: "archived",
      rows: [{ id: "row-archived", action: "y", createdAt: "2026-04-01T00:00:00.000Z" }],
    });

    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: [], // <-- no memberships; assertCompanyAccess would 403
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/companies/deleted-company-id/audit");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("archived");
    expect(mockActivityService.retrieveAuditTrail).toHaveBeenCalledWith("deleted-company-id");
  });
});
