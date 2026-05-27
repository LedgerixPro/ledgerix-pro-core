import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// Mock qbo-client and xero-client BEFORE importing the module under test.
// Same pattern as server/src/services/accounting/find-or-create-customer.test.ts.
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

import {
  createDb,
  accountingConnections,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  companies,
} from "@paperclipai/db";
import { qboRequest } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import {
  getTransactionById,
  TransactionNotFoundError,
} from "./transaction-lookup.js";
import { HttpResponseError } from "./http-error.js";

// ===========================================================================
// UNIT TESTS — mocked db, mocked platform clients
// ===========================================================================

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const CONTACT_ID = "test-contact-id";

function mockDbWithPlatform(platform: "quickbooks" | "xero" | null) {
  // Mimics: db.select().from(...).where(...).limit(1)
  // returns either [{ platform }] or []
  const result = platform === null ? [] : [{ platform }];
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  return {
    select: vi.fn().mockReturnValue(chain),
  } as never;
}

describe("getTransactionById — hinted-type fast path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches directly to fetchQboPurchase when hintedType='Purchase'", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: {
        Id: "txn-1",
        SyncToken: "0",
        Line: [
          {
            AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-42" } },
          },
        ],
      },
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-1", "Purchase");

    expect(result).toEqual({
      txnId: "txn-1",
      platform: "quickbooks",
      txnType: "Purchase",
      previousAccountRef: "acc-42",
      raw: expect.objectContaining({ Id: "txn-1", SyncToken: "0" }),
    });
    expect(qboRequest).toHaveBeenCalledTimes(1);
    expect(qboRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/purchase/txn-1",
    );
    expect(xeroRequest).not.toHaveBeenCalled();
  });

  it("dispatches directly to fetchQboBill when hintedType='Bill'", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Bill: {
        Id: "bill-7",
        SyncToken: "0",
        Line: [
          {
            AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-9" } },
          },
        ],
      },
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "bill-7", "Bill");

    expect(result.txnType).toBe("Bill");
    expect(result.previousAccountRef).toBe("acc-9");
    expect(qboRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/bill/bill-7",
    );
  });

  it("dispatches directly to fetchQboJournalEntry when hintedType='JournalEntry'", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      JournalEntry: {
        Id: "txn-JE-1",
        SyncToken: "0",
        Line: [
          {
            DetailType: "JournalEntryLineDetail",
            JournalEntryLineDetail: {
              PostingType: "Debit",
              AccountRef: { value: "60100" },
            },
          },
          {
            DetailType: "JournalEntryLineDetail",
            JournalEntryLineDetail: {
              PostingType: "Credit",
              AccountRef: { value: "20100" },
            },
          },
        ],
      },
    });

    const result = await getTransactionById(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "txn-JE-1",
      "JournalEntry",
    );

    expect(result).toEqual({
      txnId: "txn-JE-1",
      platform: "quickbooks",
      txnType: "JournalEntry",
      previousAccountRef: "60100", // First line's account (the Debit side) per the documented approximation
      raw: expect.objectContaining({ Id: "txn-JE-1" }),
    });
    expect(qboRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/journalentry/txn-JE-1",
    );
  });

  it("dispatches directly to fetchQboDeposit when hintedType='Deposit'", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Deposit: {
        Id: "txn-DEP-1",
        SyncToken: "0",
        DepositToAccountRef: { value: "10000" }, // bank account (destination — NOT captured)
        Line: [
          {
            DetailType: "DepositLineDetail",
            DepositLineDetail: {
              AccountRef: { value: "40100" }, // source account — captured as previousAccountRef
              PaymentMethodRef: { value: "1" },
            },
          },
        ],
      },
    });

    const result = await getTransactionById(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "txn-DEP-1",
      "Deposit",
    );

    expect(result).toEqual({
      txnId: "txn-DEP-1",
      platform: "quickbooks",
      txnType: "Deposit",
      previousAccountRef: "40100", // First line's source AccountRef (NOT the destination DepositToAccountRef)
      raw: expect.objectContaining({ Id: "txn-DEP-1" }),
    });
    expect(qboRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/deposit/txn-DEP-1",
    );
  });

  it("dispatches directly to fetchQboBillPayment when hintedType='BillPayment' and PayType='Check' (captures BankAccountRef)", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      BillPayment: {
        Id: "txn-BP-1",
        SyncToken: "0",
        PayType: "Check",
        VendorRef: { value: "21" },
        TotalAmt: 100.0,
        CheckPayment: {
          BankAccountRef: { value: "10100" }, // checking account — captured
          PrintStatus: "NotSet",
        },
        Line: [
          {
            Amount: 100.0,
            LinkedTxn: [{ TxnId: "313", TxnType: "Bill" }],
          },
        ],
      },
    });

    const result = await getTransactionById(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "txn-BP-1",
      "BillPayment",
    );

    expect(result).toEqual({
      txnId: "txn-BP-1",
      platform: "quickbooks",
      txnType: "BillPayment",
      previousAccountRef: "10100", // CheckPayment.BankAccountRef
      raw: expect.objectContaining({ Id: "txn-BP-1" }),
    });
    expect(qboRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/billpayment/txn-BP-1",
    );
  });

  it("dispatches directly to fetchQboBillPayment when hintedType='BillPayment' and PayType='CreditCard' (captures CCAccountRef)", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      BillPayment: {
        Id: "txn-BP-2",
        SyncToken: "0",
        PayType: "CreditCard",
        VendorRef: { value: "21" },
        TotalAmt: 250.0,
        CreditCardPayment: {
          CCAccountRef: { value: "21500" }, // credit card account — captured
        },
        Line: [
          {
            Amount: 250.0,
            LinkedTxn: [{ TxnId: "314", TxnType: "Bill" }],
          },
        ],
      },
    });

    const result = await getTransactionById(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "txn-BP-2",
      "BillPayment",
    );

    expect(result).toEqual({
      txnId: "txn-BP-2",
      platform: "quickbooks",
      txnType: "BillPayment",
      previousAccountRef: "21500", // CreditCardPayment.CCAccountRef
      raw: expect.objectContaining({ Id: "txn-BP-2" }),
    });
  });

  it("returns null previousAccountRef for BillPayment with unknown PayType (defensive)", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      BillPayment: {
        Id: "txn-BP-3",
        SyncToken: "0",
        PayType: "SomeFuturePayType", // not Check or CreditCard
        VendorRef: { value: "21" },
        TotalAmt: 100.0,
        Line: [
          {
            Amount: 100.0,
            LinkedTxn: [{ TxnId: "315", TxnType: "Bill" }],
          },
        ],
      },
    });

    const result = await getTransactionById(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "txn-BP-3",
      "BillPayment",
    );

    expect(result).toEqual({
      txnId: "txn-BP-3",
      platform: "quickbooks",
      txnType: "BillPayment",
      previousAccountRef: null, // unknown PayType → defensive null
      raw: expect.objectContaining({ Id: "txn-BP-3" }),
    });
  });

  it("dispatches directly to fetchXeroBankTransaction when hintedType='BankTransaction'", async () => {
    const db = mockDbWithPlatform("xero");
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      BankTransactions: [
        {
          BankTransactionID: "xtxn-9",
          LineItems: [{ LineItemID: "li-1", AccountCode: "200" }],
        },
      ],
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "xtxn-9", "BankTransaction");

    expect(result).toEqual({
      txnId: "xtxn-9",
      platform: "xero",
      txnType: "BankTransaction",
      previousAccountRef: "200",
      raw: expect.objectContaining({ BankTransactionID: "xtxn-9" }),
    });
    expect(xeroRequest).toHaveBeenCalledTimes(1);
    expect(xeroRequest).toHaveBeenCalledWith(
      db,
      COMPANY_ID,
      CONTACT_ID,
      "GET",
      "/BankTransactions/xtxn-9",
    );
    expect(qboRequest).not.toHaveBeenCalled();
  });

  it("throws clear error when hintedType is unknown for the platform", async () => {
    const db = mockDbWithPlatform("quickbooks");

    await expect(
      getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-1", "NonexistentType"),
    ).rejects.toThrow(/Unknown quickbooks transaction type: NonexistentType/);
    expect(qboRequest).not.toHaveBeenCalled();
  });
});

describe("getTransactionById — multi-type probing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("succeeds on the first registered type when it returns 200", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: {
        Id: "txn-A",
        SyncToken: "0",
        Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-A" } } }],
      },
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-A");

    expect(result.txnType).toBe("Purchase");
    expect(qboRequest).toHaveBeenCalledTimes(1);
  });

  it("falls through to the second type when the first throws", async () => {
    const db = mockDbWithPlatform("quickbooks");
    // First call (Purchase) throws a 404 HttpResponseError (Phase 2 strict
    // semantics: only HttpResponseError.isNotFound continues to next type).
    vi.mocked(qboRequest)
      .mockRejectedValueOnce(
        new HttpResponseError(
          "QBO request failed: 404 GET /purchase/txn-B",
          404,
          "GET",
          "/purchase/txn-B",
          "Object Not Found",
        ),
      )
      .mockResolvedValueOnce({
        Bill: {
          Id: "txn-B",
          SyncToken: "0",
          Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-B" } } }],
        },
      });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-B");

    expect(result.txnType).toBe("Bill");
    expect(result.previousAccountRef).toBe("acc-B");
    expect(qboRequest).toHaveBeenCalledTimes(2);
  });

  it("throws TransactionNotFoundError when all types are exhausted", async () => {
    const db = mockDbWithPlatform("quickbooks");
    // All registered types throw 404 (Phase 2 strict: only 404 continues
    // the probe loop; non-404 rethrows immediately). Purchase, Bill, and
    // JournalEntry all return 404 → loop exhausts → TransactionNotFoundError.
    // NOTE: When new types are added to QBO_TYPE_REGISTRY, add a corresponding
    // mockRejectedValueOnce call here so the loop reaches exhaustion.
    const make404 = (path: string) =>
      new HttpResponseError(
        `QBO request failed: 404 GET ${path}`,
        404,
        "GET",
        path,
        "Object Not Found",
      );
    vi.mocked(qboRequest)
      .mockRejectedValueOnce(make404("/purchase/txn-missing"))
      .mockRejectedValueOnce(make404("/bill/txn-missing"))
      .mockRejectedValueOnce(make404("/journalentry/txn-missing"))
      .mockRejectedValueOnce(make404("/deposit/txn-missing"))
      .mockRejectedValueOnce(make404("/billpayment/txn-missing"));

    // Capture the error from a single invocation; assert type AND properties
    // on the same caught value (avoids calling the function twice, which
    // would consume the queued mocks twice).
    let caught: unknown;
    try {
      await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-missing");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransactionNotFoundError);
    const tnf = caught as TransactionNotFoundError;
    expect(tnf.platform).toBe("quickbooks");
    expect(tnf.attemptedTypes).toContain("Purchase");
    expect(tnf.attemptedTypes).toContain("Bill");
    expect(tnf.attemptedTypes).toContain("JournalEntry");
    expect(tnf.attemptedTypes).toContain("Deposit");
    expect(tnf.attemptedTypes).toContain("BillPayment");
  });

  it("for Xero, attempts BankTransaction when no hint provided", async () => {
    const db = mockDbWithPlatform("xero");
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      BankTransactions: [
        { BankTransactionID: "x-1", LineItems: [{ AccountCode: "400" }] },
      ],
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "x-1");

    expect(result.txnType).toBe("BankTransaction");
    expect(result.previousAccountRef).toBe("400");
  });

  it("continues to next type ONLY when error is HttpResponseError with status 404", async () => {
    const db = mockDbWithPlatform("quickbooks");
    // First Purchase attempt throws a 404 (wrong type) — should continue
    // Then Bill attempt succeeds
    vi.mocked(qboRequest)
      .mockRejectedValueOnce(
        new HttpResponseError(
          "QBO request failed: 404 GET /purchase/txn-X — Object Not Found",
          404,
          "GET",
          "/purchase/txn-X",
          "Object Not Found",
        ),
      )
      .mockResolvedValueOnce({
        Bill: {
          Id: "txn-X",
          SyncToken: "0",
          Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-X" } } }],
        },
      });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-X");

    expect(result.txnType).toBe("Bill");
    expect(result.previousAccountRef).toBe("acc-X");
    expect(qboRequest).toHaveBeenCalledTimes(2);
  });

  it("RETHROWS non-404 HttpResponseError instead of continuing to next type (REGRESSION: Phase 2 strict discriminator)", async () => {
    // A 500 from the Purchase endpoint should NOT cause the dispatcher
    // to silently move on to Bill — the 500 is a genuine upstream failure
    // the caller needs to see. Phase 1 had this loose; Phase 2 tightens it.
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockRejectedValueOnce(
      new HttpResponseError(
        "QBO request failed: 500 GET /purchase/txn-Y — Internal Server Error",
        500,
        "GET",
        "/purchase/txn-Y",
        "Internal Server Error",
      ),
    );

    // Single invocation, capture the error, assert type AND status on the
    // same caught value. Must be HttpResponseError (NOT TransactionNotFoundError)
    // — proving the 500 was rethrown immediately, not silently treated as
    // "wrong type, try next".
    let caught: unknown;
    try {
      await getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-Y");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpResponseError);
    expect((caught as HttpResponseError).status).toBe(500);
    // Dispatcher should have stopped after Purchase (one call), not attempted Bill.
    expect(qboRequest).toHaveBeenCalledTimes(1);
  });

  it("RETHROWS non-HttpResponseError errors (network failure, malformed response, etc.)", async () => {
    // An error that isn't even an HttpResponseError — e.g., a network-level
    // failure or a thrown Error from upstream JSON parsing — must also
    // propagate up, not be swallowed as "wrong type".
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockRejectedValueOnce(
      new Error("network: ECONNREFUSED"),
    );

    await expect(
      getTransactionById(db, COMPANY_ID, CONTACT_ID, "txn-Z"),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("getTransactionById — previousAccountRef extraction edge cases", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null previousAccountRef when QBO Purchase has no Line array", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: { Id: "p1", SyncToken: "0" }, // no Line field
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "p1", "Purchase");

    expect(result.previousAccountRef).toBeNull();
  });

  it("returns null previousAccountRef when AccountRef is missing", async () => {
    const db = mockDbWithPlatform("quickbooks");
    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: {
        Id: "p2",
        SyncToken: "0",
        Line: [{ Description: "no account based detail" }],
      },
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "p2", "Purchase");

    expect(result.previousAccountRef).toBeNull();
  });

  it("returns null previousAccountRef when Xero LineItems is empty", async () => {
    const db = mockDbWithPlatform("xero");
    vi.mocked(xeroRequest).mockResolvedValueOnce({
      BankTransactions: [{ BankTransactionID: "x2", LineItems: [] }],
    });

    const result = await getTransactionById(db, COMPANY_ID, CONTACT_ID, "x2", "BankTransaction");

    expect(result.previousAccountRef).toBeNull();
  });
});

// ===========================================================================
// INTEGRATION TESTS — real embedded-postgres for accounting_connections lookup
// ===========================================================================

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("getTransactionById integration — real DB platform lookup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const TEST_COMPANY_ID = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-transaction-lookup-");
    db = createDb(tempDb.connectionString);

    // Seed the company row so accounting_connections.companyId FK resolves.
    await db.insert(companies).values({
      id: TEST_COMPANY_ID,
      name: "Test Co",
      issuePrefix: `T${TEST_COMPANY_ID.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }, 30_000);

  afterEach(async () => {
    await db.delete(accountingConnections);
  });

  afterAll(async () => {
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("throws when no accounting_connections row exists for (companyId, contactId)", async () => {
    // Mocks for qboRequest/xeroRequest are still in place from the top-of-file
    // vi.mock(). Reset them so prior unit-test cumulative state doesn't leak.
    vi.mocked(qboRequest).mockReset();
    vi.mocked(xeroRequest).mockReset();

    await expect(
      getTransactionById(db, TEST_COMPANY_ID, "nonexistent-contact", "txn-x"),
    ).rejects.toThrow(/No accounting connection found/);
  });

  it("looks up platform=quickbooks from real DB and dispatches to QBO handler", async () => {
    vi.mocked(qboRequest).mockReset();
    vi.mocked(xeroRequest).mockReset();

    const contactId = "qbo-contact-1";
    await db.insert(accountingConnections).values({
      companyId: TEST_COMPANY_ID,
      platform: "quickbooks",
      contactId,
      realmId: "test-realm-1",
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });

    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: {
        Id: "real-txn-1",
        SyncToken: "0",
        Line: [{ AccountBasedExpenseLineDetail: { AccountRef: { value: "acc-real" } } }],
      },
    });

    const result = await getTransactionById(
      db,
      TEST_COMPANY_ID,
      contactId,
      "real-txn-1",
      "Purchase",
    );

    expect(result.platform).toBe("quickbooks");
    expect(result.previousAccountRef).toBe("acc-real");
  });

  it("looks up platform=xero from real DB and dispatches to Xero handler", async () => {
    vi.mocked(qboRequest).mockReset();
    vi.mocked(xeroRequest).mockReset();

    const contactId = "xero-contact-1";
    await db.insert(accountingConnections).values({
      companyId: TEST_COMPANY_ID,
      platform: "xero",
      contactId,
      realmId: "test-realm-x",
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });

    vi.mocked(xeroRequest).mockResolvedValueOnce({
      BankTransactions: [
        { BankTransactionID: "xero-real-1", LineItems: [{ AccountCode: "500" }] },
      ],
    });

    const result = await getTransactionById(
      db,
      TEST_COMPANY_ID,
      contactId,
      "xero-real-1",
      "BankTransaction",
    );

    expect(result.platform).toBe("xero");
    expect(result.previousAccountRef).toBe("500");
  });

  it("respects null contactId — looks up the global connection row", async () => {
    vi.mocked(qboRequest).mockReset();
    vi.mocked(xeroRequest).mockReset();

    // Seed a global (contactId IS NULL) connection.
    await db.insert(accountingConnections).values({
      companyId: TEST_COMPANY_ID,
      platform: "quickbooks",
      contactId: null,
      realmId: "test-realm-global",
      accessToken: "encrypted-access",
      refreshToken: "encrypted-refresh",
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86400_000),
    });

    vi.mocked(qboRequest).mockResolvedValueOnce({
      Purchase: { Id: "g1", SyncToken: "0", Line: [] },
    });

    const result = await getTransactionById(db, TEST_COMPANY_ID, null, "g1", "Purchase");

    expect(result.platform).toBe("quickbooks");
    expect(result.previousAccountRef).toBeNull();
  });
});
