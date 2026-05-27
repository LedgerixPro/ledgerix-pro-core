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

  it("returns 200 with the combined seed result (pricing + setupFees) and audit log id in the response envelope", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/pricing/seed").send({});

    expect(res.status).toBe(200);
    // Q2 (LOCKED): response shape is now { pricing, setupFees } — combined
    // result of the two compareAndSeed calls (service_tier_pricing + setup_fee_pricing)
    expect(res.body.data).toEqual({
      pricing: DEFAULT_SEED_RESULT,
      setupFees: DEFAULT_SEED_RESULT,
    });
    expect(res.body.meta).toHaveProperty("performedAt");
    expect(res.body.meta.auditLogId).toBe(DEFAULT_AUDIT_ROW.id);
  });

  it("calls compareAndSeed TWICE: once for service_tier_pricing, once for setup_fee_pricing", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/pricing/seed").send({});

    // Q2 (LOCKED): two seed operations per request
    expect(compareAndSeed).toHaveBeenCalledTimes(2);

    // First call: service_tier_pricing (existing)
    const firstOpts = (compareAndSeed as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(firstOpts.identityFields).toEqual(["tier", "isCharter"]);
    expect(firstOpts.valueFields).toEqual(["monthlyAmountCents", "currency"]);
    expect(firstOpts.effectiveToField).toBe("effectiveTo");
    expect(firstOpts.schemaLabel).toBe("service_tier_pricing");
    // 3 tiers × 2 charter variants = 6 canonical rows.
    expect((firstOpts.candidateRows as unknown[]).length).toBe(6);

    // Second call: setup_fee_pricing (Q2 — 3 rows, no isCharter)
    const secondOpts = (compareAndSeed as ReturnType<typeof vi.fn>).mock.calls[1][1] as Record<string, unknown>;
    expect(secondOpts.identityFields).toEqual(["tier"]); // no isCharter — setup fees don't vary
    expect(secondOpts.valueFields).toEqual(["amountCents", "currency"]);
    expect(secondOpts.effectiveToField).toBe("effectiveTo");
    expect(secondOpts.schemaLabel).toBe("setup_fee_pricing");
    // 3 tiers × 1 (no charter variants) = 3 canonical rows.
    expect((secondOpts.candidateRows as unknown[]).length).toBe(3);
  });

  it("setup fee seed candidate rows match EA Section 7 canonical values", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/pricing/seed").send({});

    const setupFeeCall = (compareAndSeed as ReturnType<typeof vi.fn>).mock.calls[1];
    const setupFeeOpts = setupFeeCall[1] as Record<string, unknown>;
    const candidateRows = setupFeeOpts.candidateRows as Array<Record<string, unknown>>;

    // Locked EA Section 7 values: Foundation $249, Growth Engine $349, Scale-Up $1,200
    expect(candidateRows).toEqual([
      { tier: "Foundation", amountCents: 24900, currency: "USD" },
      { tier: "Growth Engine", amountCents: 34900, currency: "USD" },
      { tier: "Scale-Up", amountCents: 120000, currency: "USD" },
    ]);
  });

  it("writes a success activity log with combined pricing + setupFees details and the calling user identity", async () => {
    const app = buildTestApp(localBoardActor);
    await request(app).post("/admin/pricing/seed").send({});

    expect(logActivity).toHaveBeenCalledTimes(1);
    const auditArgs = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(auditArgs.companyId).toBeNull();
    expect(auditArgs.actorType).toBe("user");
    expect(auditArgs.actorId).toBe("test-user");
    expect(auditArgs.action).toBe("admin.pricing.seed");
    // Q2 (LOCKED): entityType reflects both tables seeded in this endpoint
    expect(auditArgs.entityType).toBe("service_tier_pricing+setup_fee_pricing");
    expect(auditArgs.entityId).toBe("canonical");
    expect(auditArgs.status).toBe("success");

    // Q2 (LOCKED): details has nested pricing + setupFees sub-objects
    const details = auditArgs.details as Record<string, unknown>;
    const pricingDetails = details.pricing as Record<string, unknown>;
    expect(pricingDetails.inserted).toBe(DEFAULT_SEED_RESULT.inserted);
    expect(pricingDetails.skipped).toBe(DEFAULT_SEED_RESULT.skipped);
    expect(pricingDetails.superseded).toBe(DEFAULT_SEED_RESULT.superseded);
    expect(pricingDetails.newRows).toBe(DEFAULT_SEED_RESULT.newRows);
    expect(pricingDetails.candidateCount).toBe(6);

    const setupFeeDetails = details.setupFees as Record<string, unknown>;
    expect(setupFeeDetails.inserted).toBe(DEFAULT_SEED_RESULT.inserted);
    expect(setupFeeDetails.candidateCount).toBe(3);
  });

  it("first-time seed: data.setupFees.inserted reflects the 3 setup fee rows when compareAndSeed returns inserted:3", async () => {
    // Override the default mock: pricing returns 6 inserted, setup fees returns 3 inserted
    (compareAndSeed as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce({ inserted: 6, skipped: 0, superseded: 0, newRows: 0 })
      .mockResolvedValueOnce({ inserted: 3, skipped: 0, superseded: 0, newRows: 0 });

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/pricing/seed").send({});

    expect(res.status).toBe(200);
    expect(res.body.data.pricing.inserted).toBe(6);
    expect(res.body.data.setupFees.inserted).toBe(3);
    expect(res.body.data.setupFees.skipped).toBe(0);
  });

  it("idempotent re-seed: data.setupFees.skipped reflects 3 when all rows already exist", async () => {
    (compareAndSeed as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValueOnce({ inserted: 0, skipped: 6, superseded: 0, newRows: 0 })
      .mockResolvedValueOnce({ inserted: 0, skipped: 3, superseded: 0, newRows: 0 });

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/admin/pricing/seed").send({});

    expect(res.status).toBe(200);
    expect(res.body.data.pricing.skipped).toBe(6);
    expect(res.body.data.pricing.inserted).toBe(0);
    expect(res.body.data.setupFees.skipped).toBe(3);
    expect(res.body.data.setupFees.inserted).toBe(0);
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
