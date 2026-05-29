import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";

// Mock the service layer — must be hoisted before importing the routes
vi.mock("../services/accounting/index.js", () => ({
  getNewTransactions: vi.fn(),
}));

// Phase 5: mock the access service so requireAgentPermission's hasPermission call
// is controllable. The vi.mock factory closes over hasPermissionMock; the outer
// factory captures the binding lazily, and the inner accessService function is
// only invoked at route-mount time (inside accountingRoutes(db)), by which time
// the const is initialized. Same pattern as require-agent-permission.test.ts.
const hasPermissionMock = vi.fn();
vi.mock("../services/access.js", () => ({
  accessService: () => ({ hasPermission: hasPermissionMock }),
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
      {
        id: "txn-1",
        type: "Purchase",
        date: "2026-05-20",
        amount: 100,
        vendor: "Test Vendor A",
        accountRef: "acct-1",
        description: "Test transaction 1",
        isReconciled: true,
        status: "AUTHORISED",
      },
      {
        id: "txn-2",
        type: "Purchase",
        date: "2026-05-21",
        amount: 200,
        vendor: "Test Vendor B",
        accountRef: "acct-2",
        description: "Test transaction 2",
        isReconciled: false,
        status: "AUTHORISED",
      },
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
      type: "Purchase",
      date: "2026-05-20",
      amount: i,
      vendor: `Vendor ${i}`,
      accountRef: "acct-x",
      description: `Bulk transaction ${i}`,
      isReconciled: false,
      status: "AUTHORISED",
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

// ============================================================================
// GET /api/accounting/v1/bills
// ============================================================================

vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
  };
});

import { getBills } from "../services/accounting/index.js";

describe("GET /api/accounting/v1/bills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data and meta envelope on valid request", async () => {
    const mockBills = [
      {
        id: "bill-1",
        vendorName: "Acme Supplies",
        amount: 1250.00,
        balance: 1250.00,
        dueDate: "2026-06-15",
        daysDue: 22,
      },
      {
        id: "bill-2",
        vendorName: "Cloud Hosting Co",
        amount: 89.99,
        balance: 89.99,
        dueDate: "2026-05-25",
        daysDue: 2,
      },
    ];
    vi.mocked(getBills).mockResolvedValue({
      platform: "xero",
      bills: mockBills,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockBills);
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      recordCount: 2,
      truncated: false,
    });
    expect(typeof res.body.meta.fetchedAt).toBe("string");
    expect(new Date(res.body.meta.fetchedAt).toString()).not.toBe("Invalid Date");
    // Bills response should NOT have a 'since' field in meta (no date param)
    expect(res.body.meta.since).toBeUndefined();
  });
});

describe("GET /api/accounting/v1/bills — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when companyId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({ contactId: "test-contact-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: companyId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "companyId",
    });
  });

  it("returns 400 when contactId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({ companyId: "f60117de-1131-433c-934f-3fe88bfaa163" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: contactId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "contactId",
    });
  });

  it("returns 400 when contactId exceeds 100 characters", async () => {
    const app = buildTestApp(localBoardActor);
    const longContactId = "x".repeat(101);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: longContactId,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contactId");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "contactId",
    });
  });
});

describe("GET /api/accounting/v1/bills — authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBills).mockResolvedValue({
      platform: "xero",
      bills: [],
    });
  });

  it("returns 401 when actor type is none", async () => {
    const app = buildTestApp({ type: "none", source: "none" });
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });
});

describe("GET /api/accounting/v1/bills — service layer errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service reports no accounting connection", async () => {
    vi.mocked(getBills).mockRejectedValue(
      new Error("No accounting connection found for contact xyz"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No accounting connection for contact");
    expect(res.body.details).toMatchObject({ code: "no_connection" });
  });

  it("returns 500 when service throws an unexpected error", async () => {
    vi.mocked(getBills).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /api/accounting/v1/bills — data handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("truncates response and sets truncated:true when service returns more than 5000 bills", async () => {
    const sixThousandBills = Array.from({ length: 6000 }, (_, i) => ({
      id: `bill-${i}`,
      vendorName: `Vendor ${i}`,
      amount: i,
      balance: i,
      dueDate: "2026-06-15",
      daysDue: 22,
    }));
    vi.mocked(getBills).mockResolvedValue({
      platform: "xero",
      bills: sixThousandBills,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/bills")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5000);
    expect(res.body.meta.truncated).toBe(true);
    expect(res.body.meta.recordCount).toBe(5000);
    expect(res.body.data[0].id).toBe("bill-0");
    expect(res.body.data[4999].id).toBe("bill-4999");
  });
});

// ============================================================================
// GET /api/accounting/v1/invoices
// ============================================================================

vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
    getInvoices: vi.fn(),
  };
});

import { getInvoices } from "../services/accounting/index.js";

describe("GET /api/accounting/v1/invoices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data and meta envelope on valid request", async () => {
    const mockInvoices = [
      {
        id: "inv-1",
        customerName: "Acme Corp",
        amount: 5000.00,
        balance: 5000.00,
        invoiceDate: "2026-05-15",
        dueDate: "2026-06-14",
        daysDue: 22,
        status: "AUTHORISED",
      },
      {
        id: "inv-2",
        customerName: "Globex Inc",
        amount: 1200.50,
        balance: 600.25,
        invoiceDate: "2026-04-20",
        dueDate: "2026-05-20",
        daysDue: -3,
        status: "AUTHORISED",
      },
    ];
    vi.mocked(getInvoices).mockResolvedValue({
      platform: "xero",
      invoices: mockInvoices,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockInvoices);
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      recordCount: 2,
      truncated: false,
    });
    expect(typeof res.body.meta.fetchedAt).toBe("string");
    expect(new Date(res.body.meta.fetchedAt).toString()).not.toBe("Invalid Date");
    expect(res.body.meta.since).toBeUndefined();
  });
});

describe("GET /api/accounting/v1/invoices — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when companyId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({ contactId: "test-contact-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: companyId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "companyId",
    });
  });

  it("returns 400 when contactId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({ companyId: "f60117de-1131-433c-934f-3fe88bfaa163" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: contactId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "contactId",
    });
  });

  it("returns 400 when contactId exceeds 100 characters", async () => {
    const app = buildTestApp(localBoardActor);
    const longContactId = "x".repeat(101);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: longContactId,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contactId");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "contactId",
    });
  });
});

describe("GET /api/accounting/v1/invoices — authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getInvoices).mockResolvedValue({
      platform: "xero",
      invoices: [],
    });
  });

  it("returns 401 when actor type is none", async () => {
    const app = buildTestApp({ type: "none", source: "none" });
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });
});

describe("GET /api/accounting/v1/invoices — service layer errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service reports no accounting connection", async () => {
    vi.mocked(getInvoices).mockRejectedValue(
      new Error("No accounting connection found for contact xyz"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No accounting connection for contact");
    expect(res.body.details).toMatchObject({ code: "no_connection" });
  });

  it("returns 500 when service throws an unexpected error", async () => {
    vi.mocked(getInvoices).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /api/accounting/v1/invoices — data handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("truncates response and sets truncated:true when service returns more than 5000 invoices", async () => {
    const sixThousandInvoices = Array.from({ length: 6000 }, (_, i) => ({
      id: `inv-${i}`,
      customerName: `Customer ${i}`,
      amount: i * 10,
      balance: i * 10,
      invoiceDate: "2026-05-15",
      dueDate: "2026-06-14",
      daysDue: 22,
      status: "AUTHORISED",
    }));
    vi.mocked(getInvoices).mockResolvedValue({
      platform: "xero",
      invoices: sixThousandInvoices,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/invoices")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5000);
    expect(res.body.meta.truncated).toBe(true);
    expect(res.body.meta.recordCount).toBe(5000);
    expect(res.body.data[0].id).toBe("inv-0");
    expect(res.body.data[4999].id).toBe("inv-4999");
  });
});

// ============================================================================
// GET /api/accounting/v1/accounts
// ============================================================================

vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
    getInvoices: vi.fn(),
    getAccounts: vi.fn(),
  };
});

import { getAccounts } from "../services/accounting/index.js";

describe("GET /api/accounting/v1/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with data and meta envelope on valid request", async () => {
    const mockAccounts = [
      {
        id: "acct-1",
        code: "200",
        name: "Sales",
        type: "REVENUE",
        subType: "OPERATING_INCOME",
        active: true,
        description: "Income from primary business activity",
        currencyCode: "USD",
      },
      {
        id: "acct-2",
        code: "400",
        name: "Office Supplies",
        type: "EXPENSE",
        subType: "OPERATING_EXPENSE",
        active: true,
        description: "",
        currencyCode: "USD",
      },
    ];
    vi.mocked(getAccounts).mockResolvedValue({
      platform: "xero",
      accounts: mockAccounts,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockAccounts);
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      recordCount: 2,
      truncated: false,
    });
    expect(typeof res.body.meta.fetchedAt).toBe("string");
    expect(new Date(res.body.meta.fetchedAt).toString()).not.toBe("Invalid Date");
    expect(res.body.meta.since).toBeUndefined();
  });
});

describe("GET /api/accounting/v1/accounts — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when companyId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({ contactId: "test-contact-id" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: companyId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "companyId",
    });
  });

  it("returns 400 when contactId is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({ companyId: "f60117de-1131-433c-934f-3fe88bfaa163" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: contactId");
    expect(res.body.details).toMatchObject({
      code: "missing_parameter",
      parameter: "contactId",
    });
  });

  it("returns 400 when contactId exceeds 100 characters", async () => {
    const app = buildTestApp(localBoardActor);
    const longContactId = "x".repeat(101);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: longContactId,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid contactId");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "contactId",
    });
  });
});

describe("GET /api/accounting/v1/accounts — authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccounts).mockResolvedValue({
      platform: "xero",
      accounts: [],
    });
  });

  it("returns 401 when actor type is none", async () => {
    const app = buildTestApp({ type: "none", source: "none" });
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
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
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("User does not have access to this company");
  });
});

describe("GET /api/accounting/v1/accounts — service layer errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service reports no accounting connection", async () => {
    vi.mocked(getAccounts).mockRejectedValue(
      new Error("No accounting connection found for contact xyz"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No accounting connection for contact");
    expect(res.body.details).toMatchObject({ code: "no_connection" });
  });

  it("returns 500 when service throws an unexpected error", async () => {
    vi.mocked(getAccounts).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /api/accounting/v1/accounts — data handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("truncates response and sets truncated:true when service returns more than 5000 accounts", async () => {
    const sixThousandAccounts = Array.from({ length: 6000 }, (_, i) => ({
      id: `acct-${i}`,
      code: String(100 + i),
      name: `Account ${i}`,
      type: "EXPENSE",
      subType: "OPERATING_EXPENSE",
      active: true,
      description: "",
      currencyCode: "USD",
    }));
    vi.mocked(getAccounts).mockResolvedValue({
      platform: "xero",
      accounts: sixThousandAccounts,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/accounts")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5000);
    expect(res.body.meta.truncated).toBe(true);
    expect(res.body.meta.recordCount).toBe(5000);
    expect(res.body.data[0].id).toBe("acct-0");
    expect(res.body.data[4999].id).toBe("acct-4999");
  });
});

// ============================================================================
// GET /api/accounting/v1/reports
// ============================================================================

vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
    getInvoices: vi.fn(),
    getAccounts: vi.fn(),
    getReports: vi.fn(),
  };
});

import { getReports } from "../services/accounting/index.js";

describe("GET /api/accounting/v1/reports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with normalized report on valid ProfitAndLoss request", async () => {
    const mockReport = {
      reportType: "ProfitAndLoss",
      reportName: "Profit and Loss",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      asOfDate: null,
      rows: [
        { label: "Income", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Sales", amount: 50000, type: "Row" as const, indent: 1, accountId: "acct-sales" },
        { label: "Total Income", amount: 50000, type: "SummaryRow" as const, indent: 0, accountId: null },
        { label: "Expenses", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Rent", amount: 5000, type: "Row" as const, indent: 1, accountId: "acct-rent" },
        { label: "Total Expenses", amount: 5000, type: "SummaryRow" as const, indent: 0, accountId: null },
        { label: "Net Profit", amount: 45000, type: "SummaryRow" as const, indent: 0, accountId: null },
      ],
    };
    vi.mocked(getReports).mockResolvedValue({
      platform: "xero",
      report: mockReport,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockReport);
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      rowCount: 7,
    });
    expect(typeof res.body.meta.fetchedAt).toBe("string");
  });

  it("returns 200 with normalized report on valid BalanceSheet request", async () => {
    const mockReport = {
      reportType: "BalanceSheet",
      reportName: "Balance Sheet",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
      rows: [
        { label: "Assets", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Current Assets", amount: 0, type: "Header" as const, indent: 1, accountId: null },
        { label: "Bank Checking", amount: 25000, type: "Row" as const, indent: 2, accountId: "acct-bank" },
        { label: "Accounts Receivable", amount: 8500, type: "Row" as const, indent: 2, accountId: "acct-ar" },
        { label: "Total Current Assets", amount: 33500, type: "SummaryRow" as const, indent: 1, accountId: null },
        { label: "Total Assets", amount: 33500, type: "SummaryRow" as const, indent: 0, accountId: null },
        { label: "Liabilities", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Accounts Payable", amount: 3200, type: "Row" as const, indent: 1, accountId: "acct-ap" },
        { label: "Total Liabilities", amount: 3200, type: "SummaryRow" as const, indent: 0, accountId: null },
        { label: "Equity", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Retained Earnings", amount: 30300, type: "Row" as const, indent: 1, accountId: "acct-re" },
        { label: "Total Equity", amount: 30300, type: "SummaryRow" as const, indent: 0, accountId: null },
      ],
    };
    vi.mocked(getReports).mockResolvedValue({
      platform: "xero",
      report: mockReport,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "BalanceSheet",
        asOfDate: "2026-01-31",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockReport);
    expect(res.body.data.startDate).toBeNull();
    expect(res.body.data.endDate).toBeNull();
    expect(res.body.data.asOfDate).toBe("2026-01-31");
    expect(res.body.meta).toMatchObject({
      platform: "xero",
      rowCount: 12,
    });
  });

  it("returns 200 with debit/credit fields on valid TrialBalance request", async () => {
    // Trial Balance has a fundamentally different row shape: each data row
    // carries both debit and credit values (one is typically 0 if the account
    // only saw activity on one side). The amount field is 0 on TB rows by
    // design — consumers must read debit/credit explicitly.
    const mockReport = {
      reportType: "TrialBalance",
      reportName: "Trial Balance",
      startDate: null,
      endDate: null,
      asOfDate: "2026-01-31",
      rows: [
        { label: "Assets", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Bank Checking", amount: 0, debit: 25000, credit: 0, type: "Row" as const, indent: 1, accountId: "acct-bank" },
        { label: "Accounts Receivable", amount: 0, debit: 8500, credit: 0, type: "Row" as const, indent: 1, accountId: "acct-ar" },
        { label: "Liabilities", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Accounts Payable", amount: 0, debit: 0, credit: 3200, type: "Row" as const, indent: 1, accountId: "acct-ap" },
        { label: "Revenue", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Sales", amount: 0, debit: 0, credit: 50000, type: "Row" as const, indent: 1, accountId: "acct-sales" },
        { label: "Expenses", amount: 0, type: "Header" as const, indent: 0, accountId: null },
        { label: "Rent Expense", amount: 0, debit: 5000, credit: 0, type: "Row" as const, indent: 1, accountId: "acct-rent" },
        { label: "TOTAL", amount: 0, debit: 38500, credit: 53200, type: "SummaryRow" as const, indent: 0, accountId: null },
      ],
    };
    vi.mocked(getReports).mockResolvedValue({
      platform: "quickbooks",
      report: mockReport,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "TrialBalance",
        asOfDate: "2026-01-31",
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockReport);
    // Verify TB-specific properties: amount is 0 on data rows, debit/credit
    // carry the actual values.
    const bankRow = res.body.data.rows.find((r: { label: string }) => r.label === "Bank Checking");
    expect(bankRow.amount).toBe(0);
    expect(bankRow.debit).toBe(25000);
    expect(bankRow.credit).toBe(0);
    const salesRow = res.body.data.rows.find((r: { label: string }) => r.label === "Sales");
    expect(salesRow.amount).toBe(0);
    expect(salesRow.debit).toBe(0);
    expect(salesRow.credit).toBe(50000);
    // Header rows do not have debit/credit (undefined)
    const assetsHeader = res.body.data.rows.find((r: { label: string }) => r.label === "Assets");
    expect(assetsHeader.debit).toBeUndefined();
    expect(assetsHeader.credit).toBeUndefined();
    expect(res.body.meta).toMatchObject({
      platform: "quickbooks",
      rowCount: 10,
    });
  });
});

describe("GET /api/accounting/v1/reports — input validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when type is missing", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: type");
  });

  it("returns 400 when type is not a recognized report type", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "InvalidReportType",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid report type");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "type",
    });
    expect(res.body.details.allowed).toContain("ProfitAndLoss");
  });

  it("returns 400 when startDate is missing for ProfitAndLoss", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: startDate");
  });

  it("returns 400 when endDate is missing for ProfitAndLoss", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: endDate");
  });

  it("returns 400 when startDate is not in YYYY-MM-DD format", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "01/01/2026",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid date format for 'startDate'");
  });

  it("returns 400 when asOfDate is missing for BalanceSheet", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "BalanceSheet",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required parameter: asOfDate");
  });
});

describe("GET /api/accounting/v1/reports — authentication and authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReports).mockResolvedValue({
      platform: "xero",
      report: {
        reportType: "ProfitAndLoss",
        reportName: "Profit and Loss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        asOfDate: null,
        rows: [],
      },
    });
  });

  it("returns 401 when actor type is none", async () => {
    const app = buildTestApp({ type: "none", source: "none" });
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
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
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Agent key cannot access another company");
  });
});

describe("GET /api/accounting/v1/reports — service layer behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when service reports no accounting connection", async () => {
    vi.mocked(getReports).mockRejectedValue(
      new Error("No accounting connection found for contact xyz"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No accounting connection for contact");
    expect(res.body.details).toMatchObject({ code: "no_connection" });
  });

  it("returns 501 for not-yet-implemented report types (CashFlow)", async () => {
    // BalanceSheet was added May 23 (commit follows); CashFlow and TrialBalance
    // remain unimplemented and continue to exercise the 501 translation path.
    vi.mocked(getReports).mockRejectedValue(
      new Error("Report type not yet implemented: CashFlow"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "CashFlow",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Report type not yet implemented");
    expect(res.body.details).toMatchObject({
      code: "not_implemented",
      reportType: "CashFlow",
    });
  });

  it("returns 500 when service throws an unexpected error", async () => {
    vi.mocked(getReports).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "ProfitAndLoss",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

// ============================================================================
// POST /api/accounting/v1/transactions/:txnId/category
// ============================================================================

vi.mock("../services/accounting/transaction-write.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/accounting/transaction-write.js")>();
  return {
    ...actual,
    updateTransactionCategory: vi.fn(),
  };
});

vi.mock("../services/approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/approvals.js")>();
  return {
    ...actual,
    approvalService: vi.fn(),
  };
});

vi.mock("../services/idempotency.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/idempotency.js")>();
  return {
    ...actual,
    withIdempotency: vi.fn(),
  };
});

import {
  updateTransactionCategory,
  TransactionTypeNotCategorizableError,
} from "../services/accounting/transaction-write.js";
import { TransactionNotFoundError } from "../services/accounting/transaction-lookup.js";
import { approvalService } from "../services/approvals.js";
import { withIdempotency } from "../services/idempotency.js";

const POST_COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";

describe("POST /api/accounting/v1/transactions/:txnId/category", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default withIdempotency: pass-through (no idempotency key → real
    // semantics), just runs the work and returns { ...result, replayed: false }
    vi.mocked(withIdempotency).mockImplementation(async (_db, _opts, work) => {
      const r = await work();
      return { ...r, replayed: false };
    });
  });

  it("returns 200 with data envelope on successful write", async () => {
    vi.mocked(updateTransactionCategory).mockResolvedValueOnce({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-pur-1",
      previousAccountRef: "60100",
      newAccountRef: "60200",
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-pur-1/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data).toEqual({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-pur-1",
      previousAccountRef: "60100",
      newAccountRef: "60200",
    });
    expect(res.body.meta.idempotencyReplay).toBe(false);
    expect(typeof res.body.meta.performedAt).toBe("string");
    expect(typeof res.body.meta.latencyMs).toBe("number");

    // No hintedType — endpoint callers don't know transaction types, so
    // the route omits the 6th arg (dispatcher does multi-type probe).
    expect(updateTransactionCategory).toHaveBeenCalledWith(
      fakeDb,
      POST_COMPANY_ID,
      "test-contact-id",
      "txn-pur-1",
      "60200",
    );
  });

  it("returns 202 + creates approval when TransactionNotFoundError is thrown", async () => {
    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(
      new TransactionNotFoundError(
        "quickbooks",
        "txn-missing",
        ["Purchase", "Bill", "JournalEntry", "Deposit", "BillPayment", "Payment", "Invoice"],
      ),
    );

    const fakeApproval = {
      id: "approval-uuid-1",
      companyId: POST_COMPANY_ID,
      type: "accounting.transaction.category_with_unknown_previous",
      status: "pending",
    };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({
      create: createMock,
    } as any);

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-missing/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
        reason: "Bookkeeper override",
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.data.approvalId).toBe("approval-uuid-1");
    expect(res.body.data.approvalType).toBe(
      "accounting.transaction.category_with_unknown_previous",
    );
    expect(res.body.data.reason).toContain("txn-missing");
    expect(res.body.data.reason).toContain("Purchase, Bill");
    expect(res.body.meta.idempotencyReplay).toBe(false);

    // Verify approvalService.create received the right payload shape
    expect(createMock).toHaveBeenCalledTimes(1);
    const [createdCompanyId, createPayload] = createMock.mock.calls[0];
    expect(createdCompanyId).toBe(POST_COMPANY_ID);
    expect(createPayload.type).toBe(
      "accounting.transaction.category_with_unknown_previous",
    );
    expect(createPayload.status).toBe("pending");
    // FK separation: board actor → requestedByUserId set, requestedByAgentId null
    expect(createPayload.requestedByUserId).toBe("test-user");
    expect(createPayload.requestedByAgentId).toBeNull();
    expect(createPayload.payload).toMatchObject({
      requestType: "POST /api/accounting/v1/transactions/:txnId/category",
      companyId: POST_COMPANY_ID,
      contactId: "test-contact-id",
      txnId: "txn-missing",
      newAccountRef: "60200",
      reason: "Bookkeeper override",
      unknownPreviousReason: "transaction_type_unknown",
    });
  });

  it("uses requestedByAgentId (not requestedByUserId) when actor is an agent", async () => {
    // Phase 5 (L1-revised): granted agent — hasPermission → true so the request reaches the handler.
    hasPermissionMock.mockResolvedValue(true);

    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(
      new TransactionNotFoundError(
        "quickbooks",
        "txn-agent-1",
        ["Purchase", "Bill"],
      ),
    );

    const fakeApproval = { id: "approval-uuid-agent-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({
      create: createMock,
    } as any);

    // Agent actor scoped to the same company they're operating on (per
    // authz.ts agent rules: agent.companyId must match the request's
    // companyId or the request is 403).
    const agentActor: ActorOverride = {
      type: "agent",
      agentId: "agent-xyz-789",
      companyId: POST_COMPANY_ID,
      source: "agent_key",
    };
    const app = buildTestApp(agentActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-agent-1/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
      });

    expect(res.status).toBe(202);
    expect(res.body.data.approvalId).toBe("approval-uuid-agent-1");

    // FK separation: agent actor → requestedByAgentId set, requestedByUserId null.
    // This is the assertion that would have caught the latent FK bug from
    // the original Piece C implementation (which stored agentId in
    // requestedByUserId, violating the users FK constraint).
    expect(createMock).toHaveBeenCalledTimes(1);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.requestedByUserId).toBeNull();
    expect(createPayload.requestedByAgentId).toBe("agent-xyz-789");
  });

  it("returns 400 when TransactionTypeNotCategorizableError is thrown", async () => {
    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(
      new TransactionTypeNotCategorizableError(
        "quickbooks",
        "BillPayment",
        "txn-bp-1",
      ),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-bp-1/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("quickbooks.BillPayment");
    expect(res.body.error).toContain("does not support category updates");
    expect(res.body.details).toMatchObject({
      code: "transaction_type_not_categorizable",
      platform: "quickbooks",
      txnType: "BillPayment",
      txnId: "txn-bp-1",
    });
  });

  it("returns 400 when newAccountRef is missing from body", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-1/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        // newAccountRef intentionally omitted
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid newAccountRef");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "newAccountRef",
    });
    // Dispatcher should NOT have been reached — body validation rejected first
    expect(updateTransactionCategory).not.toHaveBeenCalled();
  });

  it("returns idempotencyReplay: true when withIdempotency reports a replay", async () => {
    // Override the default beforeEach withIdempotency mock with a replay
    vi.mocked(withIdempotency).mockResolvedValueOnce({
      status: 200,
      body: {
        status: "success",
        data: {
          platform: "quickbooks",
          txnType: "Purchase",
          txnId: "txn-pur-1",
          previousAccountRef: "60100",
          newAccountRef: "60200",
        },
        meta: {
          performedAt: "2026-05-27T10:00:00.000Z",
          latencyMs: 12,
        },
      },
      replayed: true, // <-- the replay signal
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-pur-1/category")
      .set("Idempotency-Key", "test-idempotency-key-abc")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.meta.idempotencyReplay).toBe(true);

    // The inner work function should NOT have been invoked — withIdempotency
    // returned the cached response directly
    expect(updateTransactionCategory).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Phase 5 step 3 — K1 integration tests for requireAgentPermission gate.
  // Asserts the outer permission gate fires before the inner locked gate
  // sequence (validate → assertCompanyAccess → withIdempotency). The
  // ungranted-agent test sends a body that would ALSO fail body validation;
  // a 403 result (not 400) proves the permission gate is the outermost gate.
  // --------------------------------------------------------------------------

  it("Phase 5 K1: ungranted agent → 403 BEFORE 400 (permission gate is outermost)", async () => {
    hasPermissionMock.mockResolvedValue(false);

    const agentActor: ActorOverride = {
      type: "agent",
      agentId: "agent-no-grant",
      companyId: POST_COMPANY_ID,
      source: "agent_key",
    };
    const app = buildTestApp(agentActor);
    // Empty body — would otherwise fail body validation with 400
    // ("Invalid companyId"). With the gate, 403 fires first.
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-x/category")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("accounting:write_category");

    // Wiring proof: hasPermission called with ("agent" principalType, route's key)
    expect(hasPermissionMock).toHaveBeenCalledTimes(1);
    expect(hasPermissionMock).toHaveBeenCalledWith(
      POST_COMPANY_ID,
      "agent",
      "agent-no-grant",
      "accounting:write_category",
    );

    // Handler never ran — service mock NOT called (proves gate fired before validate)
    expect(updateTransactionCategory).not.toHaveBeenCalled();
  });

  it("Phase 5 K1: non-agent actor (local board) → pass-through; hasPermission NOT called (Decision C)", async () => {
    vi.mocked(updateTransactionCategory).mockResolvedValueOnce({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-board-1",
      previousAccountRef: "60100",
      newAccountRef: "60200",
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/transactions/txn-board-1/category")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        newAccountRef: "60200",
      });

    expect(res.status).toBe(200);
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// POST /api/accounting/v1/payments (Decision 6 Piece G)
// ============================================================================

// Re-declare the accounting/index.js mock including reconcilePayment.
// Vitest hoists all vi.mock calls and the last definition for a given module
// path wins. Earlier blocks for accounting/index.js (lines 7, 422, 694, 972,
// 1251) all already include the same `...actual` spread and accumulate the
// previously-mocked functions. We re-list those existing functions here so
// the route's existing callers (getNewTransactions, getBills, getInvoices,
// getAccounts, getReports) continue to resolve to spies, and we add
// reconcilePayment for Piece G's needs.
vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
    getInvoices: vi.fn(),
    getAccounts: vi.fn(),
    getReports: vi.fn(),
    reconcilePayment: vi.fn(),
  };
});

vi.mock("../services/accounting/payments-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/payments-helpers.js")>();
  return {
    ...actual,
    resolveEntityRefByPlatform: vi.fn(),
    evaluatePaymentThreshold: vi.fn(),
  };
});

import { reconcilePayment, PaymentReferenceError } from "../services/accounting/index.js";
import {
  resolveEntityRefByPlatform,
  evaluatePaymentThreshold,
  EntityRefResolutionError,
} from "../services/accounting/payments-helpers.js";

describe("POST /api/accounting/v1/payments", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default withIdempotency: pass-through (no idempotency key → real
    // semantics), just runs the work and returns { ...result, replayed: false }
    vi.mocked(withIdempotency).mockImplementation(async (_db, _opts, work) => {
      const r = await work();
      return { ...r, replayed: false };
    });
  });

  it("returns 200 with payment result when threshold is not exceeded", async () => {
    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({ exceeded: false });
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "quickbooks",
      ref: { customerId: "cust-1" },
    });
    vi.mocked(reconcilePayment).mockResolvedValueOnce({
      platform: "quickbooks",
      paymentId: "qbo-pay-1",
      invoiceId: "inv-1",
      amount: 50000,
      customerId: "cust-1",
      accountId: undefined,
      paymentDate: "2026-05-27",
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-1",
        amount: 50000,
        entityRef: "cust-1",
        paymentDate: "2026-05-27",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data).toEqual({
      platform: "quickbooks",
      paymentId: "qbo-pay-1",
      invoiceId: "inv-1",
      amount: 50000,
      customerId: "cust-1",
      accountId: undefined,
      paymentDate: "2026-05-27",
    });
    expect(res.body.meta.idempotencyReplay).toBe(false);
    expect(typeof res.body.meta.performedAt).toBe("string");
    expect(typeof res.body.meta.latencyMs).toBe("number");

    // Threshold check called with payload values
    expect(evaluatePaymentThreshold).toHaveBeenCalledWith(
      fakeDb,
      "test-contact-id",
      50000,
    );
    // Resolver + dispatcher called with payload values
    expect(resolveEntityRefByPlatform).toHaveBeenCalledWith(
      fakeDb,
      POST_COMPANY_ID,
      "test-contact-id",
      "cust-1",
    );
    expect(reconcilePayment).toHaveBeenCalledWith(
      fakeDb,
      POST_COMPANY_ID,
      "test-contact-id",
      "inv-1",
      50000,
      { customerId: "cust-1" },
      "2026-05-27",
    );
  });

  it("returns 202 + creates approval when threshold is exceeded (board actor)", async () => {
    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({
      exceeded: true,
      thresholdAmount: 1000000,
      reason: "Payment amount exceeds $10,000 threshold per EA Section 6.3",
    });

    const fakeApproval = {
      id: "approval-pay-1",
      companyId: POST_COMPANY_ID,
      type: "accounting.payment.threshold_exceeded",
      status: "pending",
    };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({
      create: createMock,
    } as any);

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-large",
        amount: 1500000, // $15,000, exceeds $10K threshold
        entityRef: "cust-1",
        paymentDate: "2026-05-27",
        reason: "Annual platform fee",
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.data.approvalId).toBe("approval-pay-1");
    expect(res.body.data.approvalType).toBe(
      "accounting.payment.threshold_exceeded",
    );
    expect(res.body.data.reason).toContain("$10,000 threshold");
    expect(res.body.meta.idempotencyReplay).toBe(false);

    // Short-circuit: resolver + dispatcher NOT called on threshold-exceed path
    expect(resolveEntityRefByPlatform).not.toHaveBeenCalled();
    expect(reconcilePayment).not.toHaveBeenCalled();

    // Approval payload structure
    expect(createMock).toHaveBeenCalledTimes(1);
    const [createdCompanyId, createPayload] = createMock.mock.calls[0];
    expect(createdCompanyId).toBe(POST_COMPANY_ID);
    expect(createPayload.type).toBe("accounting.payment.threshold_exceeded");
    expect(createPayload.status).toBe("pending");
    // FK separation: board actor → requestedByUserId set, requestedByAgentId null
    expect(createPayload.requestedByUserId).toBe("test-user");
    expect(createPayload.requestedByAgentId).toBeNull();
    expect(createPayload.payload).toMatchObject({
      requestType: "POST /api/accounting/v1/payments",
      companyId: POST_COMPANY_ID,
      contactId: "test-contact-id",
      invoiceId: "inv-large",
      amount: 1500000,
      entityRef: "cust-1",
      paymentDate: "2026-05-27",
      reason: "Annual platform fee",
      thresholdAmount: 1000000,
    });
    // Per sub-decision Q-pay-F-ii: v1 omits expectedRange even though the
    // payload contract leaves it as an optional field
    expect(createPayload.payload.expectedRange).toBeUndefined();
  });

  it("uses requestedByAgentId (not requestedByUserId) when actor is an agent and threshold is exceeded", async () => {
    // Phase 5 (L1-revised): granted agent — hasPermission → true so the request reaches the handler.
    hasPermissionMock.mockResolvedValue(true);

    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({
      exceeded: true,
      thresholdAmount: 1000000,
      reason: "Threshold exceeded",
    });

    const fakeApproval = { id: "approval-pay-agent-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({
      create: createMock,
    } as any);

    const agentActor: ActorOverride = {
      type: "agent",
      agentId: "agent-pay-xyz",
      companyId: POST_COMPANY_ID,
      source: "agent_key",
    };
    const app = buildTestApp(agentActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-large",
        amount: 1500000,
        entityRef: "cust-1",
      });

    expect(res.status).toBe(202);
    expect(res.body.data.approvalId).toBe("approval-pay-agent-1");

    // FK separation: agent actor → requestedByAgentId set, requestedByUserId null
    expect(createMock).toHaveBeenCalledTimes(1);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.requestedByUserId).toBeNull();
    expect(createPayload.requestedByAgentId).toBe("agent-pay-xyz");
  });

  it("returns 400 when EntityRefResolutionError is thrown (no_connection_found)", async () => {
    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({ exceeded: false });
    vi.mocked(resolveEntityRefByPlatform).mockRejectedValueOnce(
      new EntityRefResolutionError(POST_COMPANY_ID, "test-contact-id", "no_connection_found"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-1",
        amount: 50000,
        entityRef: "cust-1",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Entity ref resolution failed");
    expect(res.body.details).toMatchObject({
      code: "entity_ref_resolution_failed",
      reason: "no_connection_found",
    });
    // reconcilePayment must NOT have been called since the resolver failed first
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  it("returns 400 when PaymentReferenceError is thrown (wrong_ref_for_platform)", async () => {
    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({ exceeded: false });
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "xero",
      ref: { accountId: "acct-1" },
    });
    vi.mocked(reconcilePayment).mockRejectedValueOnce(
      new PaymentReferenceError(
        POST_COMPANY_ID,
        "test-contact-id",
        "xero",
        { accountId: "acct-1" },
        "wrong_ref_for_platform",
      ),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-1",
        amount: 50000,
        entityRef: "acct-1",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Payment reference invalid for platform xero");
    expect(res.body.details).toMatchObject({
      code: "payment_reference_invalid",
      platform: "xero",
      reason: "wrong_ref_for_platform",
    });
  });

  it("returns 400 when amount is missing from body", async () => {
    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-1",
        // amount intentionally omitted
        entityRef: "cust-1",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid amount (must be positive integer cents)");
    expect(res.body.details).toMatchObject({
      code: "invalid_parameter",
      parameter: "amount",
    });
    // No service-layer calls — validation rejected first
    expect(evaluatePaymentThreshold).not.toHaveBeenCalled();
    expect(resolveEntityRefByPlatform).not.toHaveBeenCalled();
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  it("returns idempotencyReplay: true when withIdempotency reports a replay", async () => {
    // Override the default beforeEach withIdempotency mock with a replay
    vi.mocked(withIdempotency).mockResolvedValueOnce({
      status: 200,
      body: {
        status: "success",
        data: {
          platform: "quickbooks",
          paymentId: "qbo-pay-cached",
          invoiceId: "inv-1",
          amount: 50000,
          customerId: "cust-1",
          accountId: undefined,
          paymentDate: "2026-05-27",
        },
        meta: {
          performedAt: "2026-05-27T10:00:00.000Z",
          latencyMs: 12,
        },
      },
      replayed: true, // <-- the replay signal
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .set("Idempotency-Key", "test-pay-idempotency-key-xyz")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-1",
        amount: 50000,
        entityRef: "cust-1",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.data.paymentId).toBe("qbo-pay-cached");
    expect(res.body.meta.idempotencyReplay).toBe(true);

    // Inner work should NOT have been invoked — withIdempotency returned cached
    expect(evaluatePaymentThreshold).not.toHaveBeenCalled();
    expect(resolveEntityRefByPlatform).not.toHaveBeenCalled();
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Phase 5 step 3 — K1 integration tests for requireAgentPermission gate.
  // Same shape as the category route's K1 tests; the 403-before-400 assertion
  // is the load-bearing proof of Decision G's outermost-gate placement.
  // --------------------------------------------------------------------------

  it("Phase 5 K1: ungranted agent → 403 BEFORE 400 (permission gate is outermost)", async () => {
    hasPermissionMock.mockResolvedValue(false);

    const agentActor: ActorOverride = {
      type: "agent",
      agentId: "agent-no-grant-pay",
      companyId: POST_COMPANY_ID,
      source: "agent_key",
    };
    const app = buildTestApp(agentActor);
    // Empty body — would otherwise fail body validation with 400
    // ("Invalid companyId"). With the gate, 403 fires first.
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("accounting:create_payment");

    // Wiring proof: hasPermission called with ("agent" principalType, route's key)
    expect(hasPermissionMock).toHaveBeenCalledTimes(1);
    expect(hasPermissionMock).toHaveBeenCalledWith(
      POST_COMPANY_ID,
      "agent",
      "agent-no-grant-pay",
      "accounting:create_payment",
    );

    // Handler never ran — service mocks NOT called (proves gate fired before validate)
    expect(evaluatePaymentThreshold).not.toHaveBeenCalled();
    expect(resolveEntityRefByPlatform).not.toHaveBeenCalled();
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  it("Phase 5 K1: non-agent actor (local board) → pass-through; hasPermission NOT called (Decision C)", async () => {
    vi.mocked(evaluatePaymentThreshold).mockResolvedValueOnce({ exceeded: false });
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "quickbooks",
      ref: { customerId: "cust-board" },
    });
    vi.mocked(reconcilePayment).mockResolvedValueOnce({
      platform: "quickbooks",
      paymentId: "qbo-pay-board",
      invoiceId: "inv-board",
      amount: 50000,
      customerId: "cust-board",
      accountId: undefined,
      paymentDate: "2026-05-29",
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/payments")
      .send({
        companyId: POST_COMPANY_ID,
        contactId: "test-contact-id",
        invoiceId: "inv-board",
        amount: 50000,
        entityRef: "cust-board",
        paymentDate: "2026-05-29",
      });

    expect(res.status).toBe(200);
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });
});

// ============================================================================
// POST /api/accounting/v1/invoices (Decision 7 Piece K)
// ============================================================================

// Re-declare the accounting/index.js mock to include qbo (namespace stub with
// createInvoice + findOrCreateCustomer for Piece K) PLUS all prior mocked
// functions (vitest hoist-last-wins). Same pattern Piece G used to extend
// the mock with reconcilePayment.
vi.mock("../services/accounting/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/index.js")>();
  return {
    ...actual,
    getNewTransactions: vi.fn(),
    getBills: vi.fn(),
    getInvoices: vi.fn(),
    getAccounts: vi.fn(),
    getReports: vi.fn(),
    reconcilePayment: vi.fn(),
    qbo: {
      ...actual.qbo,
      findOrCreateCustomer: vi.fn(),
      createInvoice: vi.fn(),
    },
  };
});

vi.mock("../services/accounting/pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/pricing.js")>();
  return {
    ...actual,
    getExpectedPriceCents: vi.fn(),
    getSetupFeeCents: vi.fn(),
  };
});

vi.mock("../services/accounting/charter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/accounting/charter.js")>();
  return {
    ...actual,
    isCharterForInvoicing: vi.fn(),
  };
});

import { qbo } from "../services/accounting/index.js";
import {
  getExpectedPriceCents,
  getSetupFeeCents,
} from "../services/accounting/pricing.js";
import { isCharterForInvoicing } from "../services/accounting/charter.js";

describe("POST /api/accounting/v1/invoices", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default pass-through withIdempotency (no idempotency key → run work + replayed: false)
    vi.mocked(withIdempotency).mockImplementation(async (_db, _opts, work) => {
      const r = await work();
      return { ...r, replayed: false };
    });
  });

  // Minimal valid recurring body — many tests start from this and tweak.
  const validRecurringBody = () => ({
    companyId: POST_COMPANY_ID,
    contactId: "ghl-contact-test",
    customerName: "ACME Corp",
    customerEmail: "billing@acme.example",
    serviceTier: "Foundation",
    billingMode: "recurring",
    billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
    lineItems: [{ description: "Foundation tier — May 2026", amount: 299 }], // $299 = 29900¢
    dueDate: "2099-06-15", // future
  });

  it("returns 201 on happy path — both gates pass (recurring, isCharter=false)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-1",
      action: "found_by_email",
    });
    vi.mocked(isCharterForInvoicing).mockResolvedValueOnce(false);
    vi.mocked(getExpectedPriceCents).mockResolvedValueOnce({
      amountCents: 29900,
      source: "tier_standard",
      priceRecordId: "tier-uuid-1",
    });
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-1",
      invoiceNumber: "INV-1001",
      totalAmt: 299,
      dueDate: "2099-06-15",
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("success");
    expect(res.body.data).toEqual({
      invoiceId: "qbo-inv-1",
      invoiceNumber: "INV-1001",
      customerId: "cust-1",
      totalAmount: 299,
      dueDate: "2099-06-15",
      status: "created",
    });
    expect(res.body.meta.idempotencyReplay).toBe(false);

    // Verify gate sequencing
    expect(qbo.findOrCreateCustomer).toHaveBeenCalledWith(
      fakeDb,
      POST_COMPANY_ID,
      null, // QBO books key
      "ACME Corp",
      "billing@acme.example",
    );
    expect(isCharterForInvoicing).toHaveBeenCalledWith(fakeDb, POST_COMPANY_ID, "ghl-contact-test");
    expect(getExpectedPriceCents).toHaveBeenCalledWith(fakeDb, "Foundation", false, "ghl-contact-test");
    expect(getSetupFeeCents).not.toHaveBeenCalled(); // recurring mode skips setup-fee lookup
    expect(qbo.createInvoice).toHaveBeenCalledWith(
      fakeDb,
      POST_COMPANY_ID,
      null,
      "cust-1",
      [{ description: "Foundation tier — May 2026", amount: 299 }], // dollars unchanged to QBO
      "2099-06-15",
    );
  });

  it("returns 201 on setup-mode happy path — getSetupFeeCents used, isCharterForInvoicing NOT called (Q-inv-1)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-2",
      action: "created_new",
    });
    vi.mocked(getSetupFeeCents).mockResolvedValueOnce({
      amountCents: 24900,
      priceRecordId: "setup-uuid-1",
    });
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-2",
      invoiceNumber: "INV-1002",
      totalAmt: 249,
      dueDate: "2099-06-15",
    });

    const body = { ...validRecurringBody(), billingMode: "setup", lineItems: [{ description: "Foundation setup fee", amount: 249 }] };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);

    expect(res.status).toBe(201);
    expect(res.body.data.invoiceId).toBe("qbo-inv-2");

    // setup mode: getSetupFeeCents USED; isCharterForInvoicing + getExpectedPriceCents NOT called
    expect(getSetupFeeCents).toHaveBeenCalledWith(fakeDb, "Foundation");
    expect(isCharterForInvoicing).not.toHaveBeenCalled();
    expect(getExpectedPriceCents).not.toHaveBeenCalled();
  });

  it("returns 202 on dedupe ambiguous (ambiguous_name_only → matchType 'name_only', confidence 0.3)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-ambig-name",
      action: "ambiguous_name_only",
      matchDetails: { submittedName: "ACME", submittedEmail: "x@y.z", storedName: "ACME", storedEmail: "other@y.z" },
    });
    const fakeApproval = { id: "approval-dedupe-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({ create: createMock } as any);

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.data.approvalId).toBe("approval-dedupe-1");
    expect(res.body.data.approvalType).toBe("accounting.invoice.dedupe_ambiguous");

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.type).toBe("accounting.invoice.dedupe_ambiguous");
    expect(createPayload.requestedByUserId).toBe("test-user");
    expect(createPayload.requestedByAgentId).toBeNull();
    expect(createPayload.payload.dedupeDecision).toEqual({
      matchedCustomerId: "cust-ambig-name",
      matchType: "name_only",
      confidence: 0.3,
    });

    // Pricing gate NOT reached
    expect(isCharterForInvoicing).not.toHaveBeenCalled();
    expect(getExpectedPriceCents).not.toHaveBeenCalled();
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("returns 202 on dedupe ambiguous (ambiguous_email_match_different_name → matchType 'email_only_different_name', confidence 0.5)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-ambig-email",
      action: "ambiguous_email_match_different_name",
    });
    const fakeApproval = { id: "approval-dedupe-2" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({ create: createMock } as any);

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(202);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.payload.dedupeDecision).toEqual({
      matchedCustomerId: "cust-ambig-email",
      matchType: "email_only_different_name",
      confidence: 0.5,
    });
  });

  it("returns 202 on pricing mismatch — only after dedupe resolves; pricingDecision fields populated", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-resolved-1",
      action: "found_by_email",
    });
    vi.mocked(isCharterForInvoicing).mockResolvedValueOnce(true);
    vi.mocked(getExpectedPriceCents).mockResolvedValueOnce({
      amountCents: 19900, // Charter Foundation
      source: "tier_charter",
      priceRecordId: "tier-uuid-2",
    });
    const fakeApproval = { id: "approval-pricing-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({ create: createMock } as any);

    // Sent $299 ($29900¢) vs expected $199 ($19900¢) → delta +10000¢
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(202);
    expect(res.body.data.approvalType).toBe("accounting.invoice.pricing_mismatch");
    expect(res.body.data.reason).toContain("29900 cents");
    expect(res.body.data.reason).toContain("19900 cents");

    expect(createMock).toHaveBeenCalledTimes(1);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.type).toBe("accounting.invoice.pricing_mismatch");
    expect(createPayload.payload.pricingDecision).toEqual({
      sentAmountCents: 29900,
      expectedAmountCents: 19900,
      isCharter: true,
      deltaCents: 10000,
      deltaPercent: 50.25, // (10000 / 19900) * 100, rounded to 2 dp
    });

    // createInvoice NOT reached — pricing escalates to HITL
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("returns 202 on pricing mismatch in setup mode (isCharter recorded as false per Q-inv-1)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-1",
      action: "found_by_email",
    });
    vi.mocked(getSetupFeeCents).mockResolvedValueOnce({
      amountCents: 24900,
      priceRecordId: "setup-uuid-1",
    });
    const fakeApproval = { id: "approval-setup-mismatch-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({ create: createMock } as any);

    const body = { ...validRecurringBody(), billingMode: "setup", lineItems: [{ description: "Foundation setup — override", amount: 299 }] };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);

    expect(res.status).toBe(202);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.payload.pricingDecision.isCharter).toBe(false);
    expect(isCharterForInvoicing).not.toHaveBeenCalled();
  });

  it("rounds per-item before summing (LOAD-BEARING regression test for the locked rounding order, Q-inv-3-α)", async () => {
    // Dataset: two items at $2.675 each. The two rounding orders genuinely
    // diverge here (verified via node REPL pre-test):
    //
    //   PER-ITEM (locked contract):
    //     Math.round(2.675 * 100) + Math.round(2.675 * 100)
    //     = Math.round(267.5)      + Math.round(267.5)
    //     = 268                    + 268
    //     = 536 cents
    //
    //   PRE-ROUND (regression to Math.round(sum * 100)):
    //     Math.round((2.675 + 2.675) * 100)
    //     = Math.round(5.35 * 100)
    //     = Math.round(535)
    //     = 535 cents
    //
    //   Δ = +1 cent
    //
    // We set the mocked getExpectedPriceCents to return 536 cents — the
    // per-item-rounded sum, the correct one. If the handler regressed to
    // pre-round summing, sentAmountCents would compute as 535, the locked
    // exact-zero-tolerance comparison (Q-inv-3-α) would flag a -1¢ delta,
    // and the route would return 202 (pricing_mismatch) instead of 201.
    // This test therefore genuinely fails on a rounding-order regression.
    //
    // The $2.675 dataset is deliberately artificial (sub-cent precision)
    // to exercise the rounding ORDER, which is the contract under test.
    // Real-world Ledgerix Pro invoices use whole-dollar or clean
    // two-decimal amounts where the orders typically coincide — but the
    // locked contract is per-item rounding regardless, so we lock it here
    // against silent refactoring.
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-1",
      action: "found_by_email",
    });
    vi.mocked(isCharterForInvoicing).mockResolvedValueOnce(false);
    vi.mocked(getExpectedPriceCents).mockResolvedValueOnce({
      amountCents: 536, // EXACTLY the per-item-rounded sum (268 + 268)
      source: "tier_standard",
      priceRecordId: "tier-uuid-rounding",
    });
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-rounding",
      invoiceNumber: "INV-RND",
      totalAmt: 5.35,
      dueDate: "2099-06-15",
    });

    const body = {
      ...validRecurringBody(),
      lineItems: [
        { description: "Foundation surcharge — part A", amount: 2.675 },
        { description: "Foundation surcharge — part B", amount: 2.675 },
      ],
    };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);

    // Per-item rounding makes sentAmountCents = 536 = expectedAmountCents → match → 201.
    // A pre-round-sum regression would compute 535 ≠ 536 → spurious 202.
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("success");
  });

  it("returns 400 when companyId is missing", async () => {
    const body = { ...validRecurringBody(), companyId: undefined } as any;
    delete body.companyId;
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid companyId");
    expect(res.body.details).toMatchObject({ code: "invalid_parameter", parameter: "companyId" });
    expect(qbo.findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("returns 400 on unknown serviceTier", async () => {
    const body = { ...validRecurringBody(), serviceTier: "Enterprise" };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid serviceTier");
    expect(res.body.details.parameter).toBe("serviceTier");
  });

  it("returns 400 on unknown billingMode", async () => {
    const body = { ...validRecurringBody(), billingMode: "annual" };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid billingMode");
    expect(res.body.details.parameter).toBe("billingMode");
  });

  it("returns 400 on empty lineItems", async () => {
    const body = { ...validRecurringBody(), lineItems: [] };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid lineItems");
    expect(res.body.details.parameter).toBe("lineItems");
  });

  it("returns 400 on per-line-item validation (zero amount)", async () => {
    const body = { ...validRecurringBody(), lineItems: [{ description: "free", amount: 0 }] };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.details.parameter).toBe("lineItems[0]");
  });

  it("returns 400 on past dueDate", async () => {
    const body = { ...validRecurringBody(), dueDate: "2020-01-01" };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must not be in the past");
    expect(res.body.details.parameter).toBe("dueDate");
  });

  it("uses requestedByAgentId (not requestedByUserId) when actor is an agent and dedupe is ambiguous", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-ambig",
      action: "ambiguous_name_only",
    });
    const fakeApproval = { id: "approval-agent-1" };
    const createMock = vi.fn().mockResolvedValueOnce(fakeApproval);
    vi.mocked(approvalService).mockReturnValueOnce({ create: createMock } as any);

    const agentActor: ActorOverride = {
      type: "agent",
      agentId: "agent-billing-1",
      companyId: POST_COMPANY_ID,
      source: "agent_key",
    };
    const app = buildTestApp(agentActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(202);
    const [, createPayload] = createMock.mock.calls[0];
    expect(createPayload.requestedByUserId).toBeNull();
    expect(createPayload.requestedByAgentId).toBe("agent-billing-1");
  });

  it("returns idempotencyReplay: true when withIdempotency reports a replay", async () => {
    vi.mocked(withIdempotency).mockResolvedValueOnce({
      status: 201,
      body: {
        status: "success",
        data: {
          invoiceId: "qbo-inv-cached",
          invoiceNumber: "INV-CACHED",
          customerId: "cust-cached",
          totalAmount: 299,
          dueDate: "2099-06-15",
          status: "created",
        },
        meta: { performedAt: "2026-05-28T10:00:00.000Z", latencyMs: 15 },
      },
      replayed: true,
    });

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .post("/accounting/v1/invoices")
      .set("Idempotency-Key", "test-invoice-idem-1")
      .send(validRecurringBody());

    expect(res.status).toBe(201);
    expect(res.body.data.invoiceId).toBe("qbo-inv-cached");
    expect(res.body.meta.idempotencyReplay).toBe(true);

    // Inner work NOT invoked
    expect(qbo.findOrCreateCustomer).not.toHaveBeenCalled();
    expect(isCharterForInvoicing).not.toHaveBeenCalled();
    expect(getExpectedPriceCents).not.toHaveBeenCalled();
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("returns 500 with pricing_not_configured code when getExpectedPriceCents throws PricingNotFoundError", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-1",
      action: "found_by_email",
    });
    vi.mocked(isCharterForInvoicing).mockResolvedValueOnce(false);
    const { PricingNotFoundError } = await vi.importActual<typeof import("../services/accounting/pricing.js")>(
      "../services/accounting/pricing.js",
    );
    vi.mocked(getExpectedPriceCents).mockRejectedValueOnce(
      new PricingNotFoundError("Foundation", false),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(validRecurringBody());

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Recurring pricing not configured");
    expect(res.body.details.code).toBe("pricing_not_configured");
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("returns 500 with setup_fee_not_configured code when getSetupFeeCents throws SetupFeeNotFoundError", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-1",
      action: "found_by_email",
    });
    const { SetupFeeNotFoundError } = await vi.importActual<typeof import("../services/accounting/pricing.js")>(
      "../services/accounting/pricing.js",
    );
    vi.mocked(getSetupFeeCents).mockRejectedValueOnce(
      new SetupFeeNotFoundError("Foundation"),
    );

    const body = { ...validRecurringBody(), billingMode: "setup", lineItems: [{ description: "setup", amount: 249 }] };
    const app = buildTestApp(localBoardActor);
    const res = await request(app).post("/accounting/v1/invoices").send(body);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Setup fee not configured");
    expect(res.body.details.code).toBe("setup_fee_not_configured");
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });
});
