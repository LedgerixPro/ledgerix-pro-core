import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the platform clients BEFORE importing the module under test. We keep
// the rest of qbo-client.js / xero-client.js intact (error classes, types)
// via `...actual` spread; only `qboRequest` / `xeroRequest` become spies.
vi.mock("./qbo-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qbo-client.js")>();
  return {
    ...actual,
    qboRequest: vi.fn(),
  };
});

vi.mock("./xero-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./xero-client.js")>();
  return {
    ...actual,
    xeroRequest: vi.fn(),
  };
});

import { accountingConnections } from "@paperclipai/db";
import { qboRequest } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import {
  reconcilePayment,
  PaymentReferenceError,
} from "./index.js";

// Decision 6 service-level tests for reconcilePayment + applyPaymentToInvoice.
// Tests use a fluent-chain mock DB keyed on table identity (parallels the
// pricing.test.ts pattern). The connection lookup is the only DB call inside
// reconcilePayment — once platform is resolved, dispatch goes to qboRequest
// or xeroRequest, both mocked above.

interface ConnectionRow {
  platform: "quickbooks" | "xero" | string;
}

function createMockDb(connectionRows: ConnectionRow[] = []) {
  let currentTable: "connections" | null = null;
  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => {
    currentTable = null;
    return db;
  });

  db.from = vi.fn((table: unknown) => {
    if (table === accountingConnections) currentTable = "connections";
    return db;
  });

  db.where = vi.fn(() => db);

  db.limit = vi.fn(async () => {
    if (currentTable === "connections") return connectionRows;
    return [];
  });

  return db;
}

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const CONTACT_ID = "contact-test-1";

describe("reconcilePayment — Q-pay-1 platform inference", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("routes to QBO implementation when connection has platform='quickbooks'", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-1", TxnDate: "2026-05-27" },
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { customerId: "cust-1" },
    );

    expect(result.platform).toBe("quickbooks");
    expect(qboRequest).toHaveBeenCalledTimes(1);
    expect(xeroRequest).not.toHaveBeenCalled();
  });

  it("routes to Xero implementation when connection has platform='xero'", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [{ PaymentID: "xero-pay-1" }],
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { accountId: "acct-1" },
      "2026-05-27",
    );

    expect(result.platform).toBe("xero");
    expect(xeroRequest).toHaveBeenCalledTimes(1);
    expect(qboRequest).not.toHaveBeenCalled();
  });

  it("throws when no connection exists for (companyId, contactId)", async () => {
    const db = createMockDb([]); // empty connection result

    await expect(
      reconcilePayment(
        db as never,
        COMPANY_ID,
        CONTACT_ID,
        "inv-1",
        10000,
        { customerId: "cust-1" },
      ),
    ).rejects.toThrow(/No accounting connection found/);
    expect(qboRequest).not.toHaveBeenCalled();
    expect(xeroRequest).not.toHaveBeenCalled();
  });

  it("throws when resolved platform is neither QBO nor Xero (defensive)", async () => {
    const db = createMockDb([{ platform: "future_platform" }]);

    await expect(
      reconcilePayment(
        db as never,
        COMPANY_ID,
        CONTACT_ID,
        "inv-1",
        10000,
        { customerId: "cust-1" },
      ),
    ).rejects.toThrow(/Unsupported platform for reconcilePayment/);
  });
});

describe("reconcilePayment — Q-pay-2 ref validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws PaymentReferenceError(no_ref_supplied) when neither customerId nor accountId provided", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);

    let caught: unknown;
    try {
      await reconcilePayment(db as never, COMPANY_ID, CONTACT_ID, "inv-1", 10000, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentReferenceError);
    const e = caught as PaymentReferenceError;
    expect(e.reason).toBe("no_ref_supplied");
    expect(e.platform).toBe("quickbooks");
    expect(e.suppliedRef).toEqual({});
    expect(qboRequest).not.toHaveBeenCalled();
  });

  it("throws PaymentReferenceError(both_refs_supplied) when both are provided", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);

    let caught: unknown;
    try {
      await reconcilePayment(db as never, COMPANY_ID, CONTACT_ID, "inv-1", 10000, {
        customerId: "cust-1",
        accountId: "acct-1",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentReferenceError);
    const e = caught as PaymentReferenceError;
    expect(e.reason).toBe("both_refs_supplied");
    expect(e.suppliedRef.customerId).toBe("cust-1");
    expect(e.suppliedRef.accountId).toBe("acct-1");
    expect(qboRequest).not.toHaveBeenCalled();
    expect(xeroRequest).not.toHaveBeenCalled();
  });

  it("throws PaymentReferenceError(wrong_ref_for_platform) when QBO connection but only accountId given", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);

    let caught: unknown;
    try {
      await reconcilePayment(db as never, COMPANY_ID, CONTACT_ID, "inv-1", 10000, {
        accountId: "acct-1",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentReferenceError);
    const e = caught as PaymentReferenceError;
    expect(e.reason).toBe("wrong_ref_for_platform");
    expect(e.platform).toBe("quickbooks");
    expect(e.suppliedRef.accountId).toBe("acct-1");
    expect(qboRequest).not.toHaveBeenCalled();
  });

  it("throws PaymentReferenceError(wrong_ref_for_platform) when Xero connection but only customerId given", async () => {
    const db = createMockDb([{ platform: "xero" }]);

    let caught: unknown;
    try {
      await reconcilePayment(db as never, COMPANY_ID, CONTACT_ID, "inv-1", 10000, {
        customerId: "cust-1",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PaymentReferenceError);
    const e = caught as PaymentReferenceError;
    expect(e.reason).toBe("wrong_ref_for_platform");
    expect(e.platform).toBe("xero");
    expect(e.suppliedRef.customerId).toBe("cust-1");
    expect(xeroRequest).not.toHaveBeenCalled();
  });

  it("error message includes the resolved platform and the supplied refs", async () => {
    const db = createMockDb([{ platform: "xero" }]);

    let caught: unknown;
    try {
      await reconcilePayment(db as never, COMPANY_ID, CONTACT_ID, "inv-1", 10000, {
        customerId: "cust-99",
      });
    } catch (err) {
      caught = err;
    }

    expect((caught as Error).message).toContain("platform=xero");
    expect((caught as Error).message).toContain("wrong_ref_for_platform");
    expect((caught as Error).message).toContain("cust-99");
  });
});

describe("reconcilePayment — Q-pay-3 audit-trail return shape", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("QBO happy path: returns platform/paymentId/invoiceId/amount/customerId/paymentDate; accountId undefined", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-123", TxnDate: "2026-05-27" },
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-7",
      15000,
      { customerId: "cust-1" },
      "2026-05-27",
    );

    expect(result).toEqual({
      platform: "quickbooks",
      paymentId: "qbo-pay-123",
      invoiceId: "inv-7",
      amount: 15000,
      customerId: "cust-1",
      paymentDate: "2026-05-27",
    });
    expect(result.accountId).toBeUndefined();
  });

  it("Xero happy path: returns platform/paymentId/invoiceId/amount/accountId/paymentDate; customerId undefined", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [{ PaymentID: "xero-pay-456" }],
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-8",
      25000,
      { accountId: "acct-1" },
      "2026-06-01",
    );

    expect(result).toEqual({
      platform: "xero",
      paymentId: "xero-pay-456",
      invoiceId: "inv-8",
      amount: 25000,
      accountId: "acct-1",
      paymentDate: "2026-06-01",
    });
    expect(result.customerId).toBeUndefined();
  });

  it("paymentDate defaulting (QBO): caller omits → resolved date comes from QBO response TxnDate", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-1", TxnDate: "2026-05-27" }, // QBO server-default
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { customerId: "cust-1" },
      // paymentDate omitted
    );

    expect(result.paymentDate).toBe("2026-05-27");
  });

  it("paymentDate defaulting (QBO): caller omits AND QBO returns no TxnDate → falls back to today", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-1" }, // no TxnDate in response
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { customerId: "cust-1" },
    );

    // Today's ISO date — match the YYYY-MM-DD shape that the handler computes
    expect(result.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("paymentDate explicit: caller provides date → result echoes it", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [{ PaymentID: "xero-pay-1" }],
    } as any);

    const result = await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { accountId: "acct-1" },
      "2026-12-31",
    );

    expect(result.paymentDate).toBe("2026-12-31");
  });

  it("Xero empty Payments array → throws defensive error (does NOT silently succeed)", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [], // pathological: HTTP success but no Payment created
    } as any);

    await expect(
      reconcilePayment(
        db as never,
        COMPANY_ID,
        CONTACT_ID,
        "inv-1",
        10000,
        { accountId: "acct-1" },
        "2026-05-27",
      ),
    ).rejects.toThrow(/Xero \/Payments POST returned no Payments in response/);
  });
});

describe("reconcilePayment — lower-layer request body verification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("QBO body: CustomerRef.value, TotalAmt, Line[0].LinkedTxn correct; TxnDate present when paymentDate provided", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-1", TxnDate: "2026-05-27" },
    } as any);

    await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-42",
      33333,
      { customerId: "cust-X" },
      "2026-05-27",
    );

    expect(qboRequest).toHaveBeenCalledTimes(1);
    const [, , , method, path, body] = vi.mocked(qboRequest).mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/payment");
    expect(body).toMatchObject({
      CustomerRef: { value: "cust-X" },
      TotalAmt: 33333,
      Line: [
        {
          Amount: 33333,
          LinkedTxn: [{ TxnId: "inv-42", TxnType: "Invoice" }],
        },
      ],
      TxnDate: "2026-05-27",
    });
  });

  it("QBO body: TxnDate ABSENT when caller omits paymentDate (let QBO server-default)", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Payment: { Id: "qbo-pay-1", TxnDate: "2026-05-27" },
    } as any);

    await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { customerId: "cust-1" },
      // paymentDate omitted
    );

    const [, , , , , body] = vi.mocked(qboRequest).mock.calls[0];
    expect(body).not.toHaveProperty("TxnDate");
  });

  it("Xero body: Payments[0] contains Invoice.InvoiceID, Account.AccountID, Amount, Date", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [{ PaymentID: "xero-pay-1" }],
    } as any);

    await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-99",
      77777,
      { accountId: "acct-Y" },
      "2026-07-15",
    );

    expect(xeroRequest).toHaveBeenCalledTimes(1);
    const [, , , method, path, body] = vi.mocked(xeroRequest).mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/Payments");
    expect(body).toEqual({
      Payments: [
        {
          Invoice: { InvoiceID: "inv-99" },
          Account: { AccountID: "acct-Y" },
          Amount: 77777,
          Date: "2026-07-15",
        },
      ],
    });
  });

  it("Xero body: Date defaults to today's ISO date when caller omits paymentDate", async () => {
    const db = createMockDb([{ platform: "xero" }]);
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      Payments: [{ PaymentID: "xero-pay-1" }],
    } as any);

    await reconcilePayment(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "inv-1",
      10000,
      { accountId: "acct-1" },
      // paymentDate omitted
    );

    const [, , , , , body] = vi.mocked(xeroRequest).mock.calls[0];
    const payment = (body as { Payments: Array<{ Date: string }> }).Payments[0];
    expect(payment.Date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
