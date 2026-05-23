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

  it("returns 501 for not-yet-implemented report types (BalanceSheet)", async () => {
    vi.mocked(getReports).mockRejectedValue(
      new Error("Report type not yet implemented: BalanceSheet"),
    );

    const app = buildTestApp(localBoardActor);
    const res = await request(app)
      .get("/accounting/v1/reports")
      .query({
        companyId: "f60117de-1131-433c-934f-3fe88bfaa163",
        contactId: "test-contact-id",
        type: "BalanceSheet",
        asOfDate: "2026-01-31",
      });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("Report type not yet implemented");
    expect(res.body.details).toMatchObject({
      code: "not_implemented",
      reportType: "BalanceSheet",
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
