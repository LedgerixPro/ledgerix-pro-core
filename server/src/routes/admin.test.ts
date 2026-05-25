import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";

// Mock the helper and activity-log service. Must be hoisted before importing
// the route. This isolates the route logic from the DB layer entirely —
// behavior of compareAndSeed itself is tested in compare-and-seed.test.ts.
vi.mock("../services/admin/compare-and-seed.js", () => ({
  compareAndSeed: vi.fn(),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

import { compareAndSeed } from "../services/admin/compare-and-seed.js";
import { logActivity } from "../services/activity-log.js";
import { adminRoutes } from "./admin.js";
import { errorHandler } from "../middleware/error-handler.js";

// Service layer is mocked; the real DB is never touched.
const fakeDb = {} as Db;

interface ActorOverride {
  type: "none" | "board" | "agent";
  source?: string;
  userId?: string;
  agentId?: string;
  companyId?: string;
  companyIds?: string[];
  memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
  isInstanceAdmin?: boolean;
}

/**
 * Build a minimal test Express app, mirroring the accounting.test.ts pattern:
 *   - JSON body parser
 *   - Mock actor middleware (sets req.actor to provided override)
 *   - Admin routes under test
 *   - Error handler middleware (so HttpError → JSON response)
 */
function buildTestApp(actor: ActorOverride) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = actor as never;
    next();
  });
  app.use(adminRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

/**
 * Local-implicit board actor — passes assertInstanceAdmin (board source =
 * local_implicit OR isInstanceAdmin = true, this has both for clarity).
 */
const localBoardActor: ActorOverride = {
  type: "board",
  source: "local_implicit",
  userId: "test-user",
  isInstanceAdmin: true,
};

/**
 * Pre-canned mock returns. Tests can override per-case via mockResolvedValueOnce.
 */
const DEFAULT_SEED_RESULT = {
  inserted: 6,
  skipped: 0,
  superseded: 0,
  newRows: 0,
};
const DEFAULT_AUDIT_ROW = { id: "audit-log-test-id" };

// -------------------------------------------------------------------------
// Auth tests — only against /admin/pricing/seed since /admin/thresholds/seed
// uses identical guards. Duplicating across both endpoints would be noise.
// -------------------------------------------------------------------------

describe("admin routes — auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Note: assertInstanceAdmin calls assertBoard FIRST, which rejects any
  // actor whose type is not "board" with 403. There is no 401 path here —
  // an unauthenticated request and a non-board request are both rejected
  // by the same guard. The admin endpoints do not call assertAuthenticated
  // separately, so 401 never surfaces. This is consistent with the rest
  // of the codebase's instance-admin endpoints.
  it("returns 403 when actor.type is 'none' (assertBoard rejects before auth check)", async () => {
    const app = buildTestApp({ type: "none" });
    const res = await request(app).post("/admin/pricing/seed").send({});
    expect(res.status).toBe(403);
    expect(compareAndSeed).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("returns 403 when actor is an agent (not a board)", async () => {
    const app = buildTestApp({
      type: "agent",
      agentId: "agent-test",
      companyId: "company-test",
    });
    const res = await request(app).post("/admin/pricing/seed").send({});
    expect(res.status).toBe(403);
    expect(compareAndSeed).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("returns 403 when actor is a board but NOT instance admin", async () => {
    const app = buildTestApp({
      type: "board",
      source: "session",
      userId: "test-user",
      isInstanceAdmin: false,
    });
    const res = await request(app).post("/admin/pricing/seed").send({});
    expect(res.status).toBe(403);
    expect(compareAndSeed).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// Happy-path tests — pricing and thresholds endpoints.
// -------------------------------------------------------------------------

describe("POST /admin/pricing/seed — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (compareAndSeed as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_SEED_RESULT);
    (logActivity as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_AUDIT_ROW);
  });

  it("returns 200 with the seed result and audit log id in the response envelope", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/pricing/seed").send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(DEFAULT_SEED_RESULT);
    expect(res.body.meta).toHaveProperty("performedAt");
    expect(res.body.meta.auditLogId).toBe(DEFAULT_AUDIT_ROW.id);
  });

  it("calls compareAndSeed with the canonical pricing seed config", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/pricing/seed").send({});

    expect(compareAndSeed).toHaveBeenCalledTimes(1);
    const callArgs = (compareAndSeed as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = callArgs[1] as Record<string, unknown>;

    // Verify the helper was called with the documented seed shape.
    expect(opts.identityFields).toEqual(["tier", "isCharter"]);
    expect(opts.valueFields).toEqual(["monthlyAmountCents", "currency"]);
    expect(opts.effectiveToField).toBe("effectiveTo");
    expect(opts.schemaLabel).toBe("service_tier_pricing");
    // 3 tiers × 2 charter variants = 6 canonical rows.
    expect((opts.candidateRows as unknown[]).length).toBe(6);
  });

  it("writes a success activity log with the seed result and the calling user identity", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/pricing/seed").send({});

    expect(logActivity).toHaveBeenCalledTimes(1);
    const auditArgs = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(auditArgs.companyId).toBeNull();
    expect(auditArgs.actorType).toBe("user");
    expect(auditArgs.actorId).toBe("test-user");
    expect(auditArgs.action).toBe("admin.pricing.seed");
    expect(auditArgs.entityType).toBe("service_tier_pricing");
    expect(auditArgs.entityId).toBe("canonical");
    expect(auditArgs.status).toBe("success");
    const details = auditArgs.details as Record<string, unknown>;
    expect(details.inserted).toBe(DEFAULT_SEED_RESULT.inserted);
    expect(details.skipped).toBe(DEFAULT_SEED_RESULT.skipped);
    expect(details.superseded).toBe(DEFAULT_SEED_RESULT.superseded);
    expect(details.newRows).toBe(DEFAULT_SEED_RESULT.newRows);
    expect(details.candidateCount).toBe(6);
  });
});

describe("POST /admin/thresholds/seed — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (compareAndSeed as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...DEFAULT_SEED_RESULT,
      inserted: 2, // 2 canonical thresholds vs 6 pricing rows
    });
    (logActivity as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_AUDIT_ROW);
  });

  it("calls compareAndSeed with the canonical threshold seed config", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/thresholds/seed").send({});

    expect(res.status).toBe(200);
    expect(compareAndSeed).toHaveBeenCalledTimes(1);
    const opts = (compareAndSeed as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;

    expect(opts.identityFields).toEqual(["endpoint", "field", "ghlContactId"]);
    expect(opts.valueFields).toEqual([
      "comparator",
      "thresholdValue",
      "action",
      "reason",
    ]);
    expect(opts.effectiveToField).toBe("effectiveTo");
    expect(opts.schemaLabel).toBe("write_thresholds");
    // 2 canonical thresholds: accounting.payments + accounting.invoices.
    expect((opts.candidateRows as unknown[]).length).toBe(2);
  });

  it("writes a success activity log under the write_thresholds entity type", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/thresholds/seed").send({});

    expect(logActivity).toHaveBeenCalledTimes(1);
    const auditArgs = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(auditArgs.action).toBe("admin.thresholds.seed");
    expect(auditArgs.entityType).toBe("write_thresholds");
    expect(auditArgs.entityId).toBe("canonical");
    expect(auditArgs.status).toBe("success");
  });
});

// -------------------------------------------------------------------------
// Failure path — when compareAndSeed throws, the route writes a failure
// audit log AND propagates the error to the Express error handler.
// -------------------------------------------------------------------------

describe("POST /admin/pricing/seed — failure path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes a failure activity log and propagates the error when compareAndSeed throws", async () => {
    const boom = new Error("simulated DB explosion during seed");
    (compareAndSeed as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
    (logActivity as ReturnType<typeof vi.fn>).mockResolvedValue(DEFAULT_AUDIT_ROW);

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/pricing/seed").send({});

    // Error propagated → errorHandler returns a 5xx (exact status depends on
    // how errorHandler maps unknown Errors; we just assert it's an error).
    expect(res.status).toBeGreaterThanOrEqual(500);

    // Activity log was still written, with status = failure and the truncated error message.
    expect(logActivity).toHaveBeenCalledTimes(1);
    const auditArgs = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(auditArgs.action).toBe("admin.pricing.seed");
    expect(auditArgs.status).toBe("failure");
    const details = auditArgs.details as Record<string, unknown>;
    expect(details.errorMessage).toContain("simulated DB explosion");
  });
});
