import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";

// Mock the service layer — must be hoisted before importing the routes
vi.mock("../services/accounting/index.js", () => ({
  getNewTransactions: vi.fn(),
}));

import { getNewTransactions } from "../services/accounting/index.js";
import { accountingRoutes } from "./accounting.js";
import { errorHandler } from "../middleware/error-handler.js";

// Type-only import; we never instantiate this — service layer is mocked
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
 * Build a minimal test Express app with:
 * - JSON body parser
 * - Mock actor middleware (sets req.actor to provided override)
 * - The accounting routes under test
 * - Error handler middleware (so HttpError → JSON response)
 */
function buildTestApp(actor: ActorOverride) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.actor = actor as any;
    next();
  });
  app.use(accountingRoutes(fakeDb));
  app.use(errorHandler);
  return app;
}

/**
 * Default board actor with local_implicit source — has auto-access to all companies.
 * Use this when the test isn't focused on auth scenarios.
 */
const localBoardActor: ActorOverride = {
  type: "board",
  source: "local_implicit",
  userId: "test-user",
  isInstanceAdmin: true,
};

describe("GET /api/accounting/v1/transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data and meta envelope on valid request", async () => {
    const mockTransactions = [
      { id: "txn-1", amount: 100, date: "2026-05-20" },
      { id: "txn-2", amount: 200, date: "2026-05-21" },
    ];
    vi.mocked(getNewTransactions).mockResolvedValue({
      platform: "xero",
      transactions: mockTransactions,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockTransactions);
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      recordCount: 2,
      truncated: false,
      since: "2026-05-01",
    });
    expect(typeof res.body.meta.fetchedAt).toBe("string");
    expect(new Date(res.body.meta.fetchedAt).toString()).not.toBe("Invalid Date");
  });

  it("returns 400 when companyId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: companyId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "companyId",
    });
  });
});

describe("GET /api/accounting/v1/transactions — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when contactId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        since: "2026-05-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: contactId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "contactId",
    });
  });

  it("returns 400 when since is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: since");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "since",
    });
  });

  it("returns 400 when contactId exceeds 100 characters", async () => {
    const app = buildTestApp(localBoardActor);
    const longContactId = "x".repeat(101);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: longContactId,
        since: "2026-05-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contactId");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "contactId",
    });
  });

  it("returns 400 when since is not in YYYY-MM-DD format", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "05/01/2026",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date format for 'since'");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "since",
      reason: "must be YYYY-MM-DD",
    });
  });
});

describe("GET /api/accounting/v1/transactions — authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getNewTransactions).mockResolvedValue({
      platform: "xero",
      transactions: [],
    });
  });

  it("returns 401 when actor type is none", async () => {
    const app = buildTestApp({ type: "none", source: "none" });
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Unauthorized");
  });

  it("returns 403 when agent tries to access another company", async () => {
    const app = buildTestApp({
      type: "agent",
      agentId: "agent-123",
      companyId: "different-company-id",
      source: "agent_key",
    });
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });

  it("returns 200 when agent accesses its own company", async () => {
    const app = buildTestApp({
      type: "agent",
      agentId: "agent-123",
      companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
      source: "agent_key",
    });
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(200);
  });

  it("returns 403 when board user lacks company in memberships", async () => {
    const app = buildTestApp({
      type: "board",
      source: "session",
      userId: "test-user",
      companyIds: ["some-other-company"],
      isInstanceAdmin: false,
    });
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });

  it("returns 403 for instance admin without explicit company membership (admin does not bypass read access)", async () => {
    // NOTE: assertCompanyAccess requires explicit company membership even for instance admins.
    // Instance admin status only affects write-method checks downstream, not read access gating.
    // This test documents that behavior.
    const app = buildTestApp({
      type: "board",
      source: "session",
      userId: "admin-user",
      companyIds: [],
      isInstanceAdmin: true,
    });
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });
});

describe("GET /api/accounting/v1/transactions — service layer errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service reports no accounting connection", async () => {
    vi.mocked(getNewTransactions).mockRejectedValue(
      new Error("No accounting connection found for contact xyz"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No accounting connection for contact");
    expect(res.body.details).toMatchObject({ code: "no_connection" });
  });

  it("returns 500 when service throws an unexpected error", async () => {
    vi.mocked(getNewTransactions).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /api/accounting/v1/transactions — data handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("truncates response and sets truncated:true when service returns more than 5000 records", async () => {
    const sixThousandTransactions = Array.from({ length: 6000 }, (_, i) => ({
      id: `txn-${i}`,
      amount: i,
      date: "2026-05-20",
    }));
    vi.mocked(getNewTransactions).mockResolvedValue({
      platform: "xero",
      transactions: sixThousandTransactions,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2026-05-01",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5000);
    expect(res.body.meta.truncated).toBe(true);
    expect(res.body.meta.recordCount).toBe(5000);
    // First 5000 records should be preserved in order
    expect(res.body.data[0].id).toBe("txn-0");
    expect(res.body.data[4999].id).toBe("txn-4999");
  });

  it("returns 400 when since is in the future", async () => {
    const app = buildTestApp(localBoardActor);
    // Use a date clearly in the future (2099)
    const res = await request(app)
      .get("/accounting/v1/transactions")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        since: "2099-01-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("'since' cannot be in the future");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "since",
    });
  });
});
