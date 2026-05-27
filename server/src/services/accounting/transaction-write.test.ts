import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock transaction-lookup BEFORE importing the module under test, so we
// can control what getTransactionById returns without going through the
// full read-side dispatcher. This is appropriate for the foundation
// commit's tests — we're testing dispatcher logic in isolation. Per-type
// handler tests (added with each Path Y commit) use the mocked HTTP
// clients pattern from transaction-lookup.test.ts.
vi.mock("./transaction-lookup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transaction-lookup.js")>();
  return {
    ...actual,
    getTransactionById: vi.fn(),
  };
});

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

import { getTransactionById } from "./transaction-lookup.js";
import { qboRequest } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import {
  updateTransactionCategory,
  TransactionTypeNotCategorizableError,
} from "./transaction-write.js";

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const CONTACT_ID = "test-contact-id";
const MOCK_DB = {} as any; // Foundation tests don't touch db directly

describe("updateTransactionCategory — Decision 5 dispatcher foundation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ===========================================================================
  // EXCLUDED-TYPE TESTS — each of the 5 excluded types should throw
  // TransactionTypeNotCategorizableError. Per Decision 5's locked scope.
  // ===========================================================================

  const excludedTypes: Array<{
    platform: "quickbooks" | "xero";
    txnType: string;
    description: string;
  }> = [
    { platform: "quickbooks", txnType: "BillPayment", description: "QBO BillPayment (funds-source reassignment, not categorization)" },
    { platform: "quickbooks", txnType: "Payment", description: "QBO Payment (funds-flow accounts, not categorization)" },
    { platform: "quickbooks", txnType: "Invoice", description: "QBO Invoice (Item-based account mapping, not direct AccountRef edit)" },
    { platform: "quickbooks", txnType: "JournalEntry", description: "QBO JournalEntry (multi-line Debit/Credit, deferred to Q5)" },
    { platform: "xero", txnType: "ManualJournal", description: "Xero ManualJournal (multi-line Debit/Credit, deferred to Q5)" },
  ];

  for (const { platform, txnType, description } of excludedTypes) {
    it(`throws TransactionTypeNotCategorizableError for excluded type: ${description}`, async () => {
      vi.mocked(getTransactionById).mockResolvedValueOnce({
        txnId: "txn-excl-1",
        platform,
        txnType,
        previousAccountRef: "some-existing-account",
        raw: { Id: "txn-excl-1" } as any,
      });

      let caught: unknown;
      try {
        await updateTransactionCategory(MOCK_DB, COMPANY_ID, CONTACT_ID, "txn-excl-1", "new-account-ref");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransactionTypeNotCategorizableError);
      const tnc = caught as TransactionTypeNotCategorizableError;
      expect(tnc.platform).toBe(platform);
      expect(tnc.txnType).toBe(txnType);
      expect(tnc.txnId).toBe("txn-excl-1");
    });
  }

  // ===========================================================================
  // PROPAGATION TESTS — errors from the read dispatcher must propagate
  // unchanged. TransactionNotFoundError must NOT be converted to
  // TransactionTypeNotCategorizableError.
  // ===========================================================================

  it("propagates TransactionNotFoundError from getTransactionById unchanged", async () => {
    // Construct a TransactionNotFoundError via the actual class. We
    // import it dynamically to avoid the vi.mock from earlier replacing it.
    const { TransactionNotFoundError } = await vi.importActual<
      typeof import("./transaction-lookup.js")
    >("./transaction-lookup.js");
    const notFound = new TransactionNotFoundError(
      "quickbooks",
      "txn-missing",
      ["Purchase", "Bill"],
    );
    vi.mocked(getTransactionById).mockRejectedValueOnce(notFound);

    await expect(
      updateTransactionCategory(MOCK_DB, COMPANY_ID, CONTACT_ID, "txn-missing", "new-acc"),
    ).rejects.toBe(notFound);
  });

  it("propagates arbitrary errors from getTransactionById unchanged", async () => {
    const networkError = new Error("network: ECONNREFUSED");
    vi.mocked(getTransactionById).mockRejectedValueOnce(networkError);

    await expect(
      updateTransactionCategory(MOCK_DB, COMPANY_ID, CONTACT_ID, "txn-X", "new-acc"),
    ).rejects.toBe(networkError);
  });

  // ===========================================================================
  // RESULT SHAPE TESTS — verify the dispatcher returns the right shape
  // when a write handler succeeds. Foundation commit has no handlers yet
  // so we register a fake one inline via a test-only registry mutation.
  // ===========================================================================

  // Note: foundation commit has empty registries. We can't directly test
  // the success path without a handler. The success path is exercised by
  // each per-type handler commit's tests (and the per-type tests verify
  // the result shape too, since the dispatcher is what returns the result).
  //
  // What we CAN test here: that when a handler IS registered for the type,
  // the dispatcher reaches the handler call. Foundation commit doesn't have
  // any registered handlers, so the success path is implicitly deferred.
  // Subsequent per-type commits will add direct success-path tests.
});

describe("TransactionTypeNotCategorizableError", () => {
  it("constructs with platform + txnType + txnId and a descriptive message", () => {
    const err = new TransactionTypeNotCategorizableError(
      "quickbooks",
      "BillPayment",
      "txn-bp-1",
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TransactionTypeNotCategorizableError);
    expect(err.name).toBe("TransactionTypeNotCategorizableError");
    expect(err.platform).toBe("quickbooks");
    expect(err.txnType).toBe("BillPayment");
    expect(err.txnId).toBe("txn-bp-1");
    expect(err.message).toContain("quickbooks.BillPayment");
    expect(err.message).toContain("txn-bp-1");
    expect(err.message).toContain("Decision 5");
  });
});

describe("updateTransactionCategory — QBO Purchase handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches to QBO Purchase handler when lookup returns Purchase type", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-pur-1",
      platform: "quickbooks",
      txnType: "Purchase",
      previousAccountRef: "60100", // existing expense account
      raw: {
        Id: "txn-pur-1",
        SyncToken: "0",
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
            },
            Amount: 100.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-pur-1",
      "60200", // new expense account
    );

    // Result shape verification
    expect(result).toEqual({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-pur-1",
      previousAccountRef: "60100",
      newAccountRef: "60200",
    });

    // Verify qboRequest was called with the right URL + mutated body
    expect(qboRequest).toHaveBeenCalledTimes(1);
    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/purchase?operation=update",
      expect.objectContaining({
        Id: "txn-pur-1",
        Line: expect.arrayContaining([
          expect.objectContaining({
            AccountBasedExpenseLineDetail: expect.objectContaining({
              AccountRef: { value: "60200" }, // mutated to new account
            }),
          }),
        ]),
      }),
    );
  });

  it("preserves non-AccountRef fields when mutating AccountBasedExpenseLineDetail", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-pur-2",
      platform: "quickbooks",
      txnType: "Purchase",
      previousAccountRef: "60100",
      raw: {
        Id: "txn-pur-2",
        SyncToken: "0",
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
              ClassRef: { value: "class-5" }, // additional field that must survive
              TaxCodeRef: { value: "NON" },
            },
            Amount: 100.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-pur-2",
      "60200",
    );

    // Verify ClassRef and TaxCodeRef survived the mutation
    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/purchase?operation=update",
      expect.objectContaining({
        Line: expect.arrayContaining([
          expect.objectContaining({
            AccountBasedExpenseLineDetail: expect.objectContaining({
              AccountRef: { value: "60200" },
              ClassRef: { value: "class-5" },
              TaxCodeRef: { value: "NON" },
            }),
          }),
        ]),
      }),
    );
  });

  it("throws if QBO Purchase has no line items", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-pur-3",
      platform: "quickbooks",
      txnType: "Purchase",
      previousAccountRef: null,
      raw: {
        Id: "txn-pur-3",
        SyncToken: "0",
        Line: [], // empty Line array — pathological case
      } as any,
    });

    await expect(
      updateTransactionCategory(
        MOCK_DB,
        COMPANY_ID,
        CONTACT_ID,
        "txn-pur-3",
        "60200",
      ),
    ).rejects.toThrow("QBO Purchase txn-pur-3 has no line items to categorize");
    // Verify qboRequest was NOT called (handler threw before posting)
    expect(qboRequest).not.toHaveBeenCalled();
  });
});

describe("updateTransactionCategory — QBO Bill handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches to QBO Bill handler when lookup returns Bill type", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-bill-1",
      platform: "quickbooks",
      txnType: "Bill",
      previousAccountRef: "60100",
      raw: {
        Id: "txn-bill-1",
        SyncToken: "0",
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
            },
            Amount: 200.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-bill-1",
      "60200",
    );

    expect(result).toEqual({
      platform: "quickbooks",
      txnType: "Bill",
      txnId: "txn-bill-1",
      previousAccountRef: "60100",
      newAccountRef: "60200",
    });

    // Verify the BILL endpoint was called (not /purchase) — this is the
    // critical assertion that distinguishes Bill from Purchase
    expect(qboRequest).toHaveBeenCalledTimes(1);
    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/bill?operation=update",
      expect.objectContaining({
        Id: "txn-bill-1",
        Line: expect.arrayContaining([
          expect.objectContaining({
            AccountBasedExpenseLineDetail: expect.objectContaining({
              AccountRef: { value: "60200" },
            }),
          }),
        ]),
      }),
    );
  });

  it("preserves non-AccountRef fields (BillableStatus, TaxCodeRef) during mutation", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-bill-2",
      platform: "quickbooks",
      txnType: "Bill",
      previousAccountRef: "60100",
      raw: {
        Id: "txn-bill-2",
        SyncToken: "0",
        Line: [
          {
            DetailType: "AccountBasedExpenseLineDetail",
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
              BillableStatus: "Billable",
              TaxCodeRef: { value: "NON" },
              CustomerRef: { value: "customer-5" },
            },
            Amount: 200.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-bill-2",
      "60200",
    );

    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/bill?operation=update",
      expect.objectContaining({
        Line: expect.arrayContaining([
          expect.objectContaining({
            AccountBasedExpenseLineDetail: expect.objectContaining({
              AccountRef: { value: "60200" },
              BillableStatus: "Billable",
              TaxCodeRef: { value: "NON" },
              CustomerRef: { value: "customer-5" },
            }),
          }),
        ]),
      }),
    );
  });

  it("throws if QBO Bill has no line items", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-bill-3",
      platform: "quickbooks",
      txnType: "Bill",
      previousAccountRef: null,
      raw: {
        Id: "txn-bill-3",
        SyncToken: "0",
        Line: [],
      } as any,
    });

    await expect(
      updateTransactionCategory(
        MOCK_DB,
        COMPANY_ID,
        CONTACT_ID,
        "txn-bill-3",
        "60200",
      ),
    ).rejects.toThrow("QBO Bill txn-bill-3 has no line items to categorize");
    expect(qboRequest).not.toHaveBeenCalled();
  });
});

describe("updateTransactionCategory — QBO Deposit handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches to QBO Deposit handler when lookup returns Deposit type (mutates per-line source AccountRef, NOT top-level DepositToAccountRef)", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-dep-1",
      platform: "quickbooks",
      txnType: "Deposit",
      previousAccountRef: "40100", // per-line source account (per Decision 4 read pattern)
      raw: {
        Id: "txn-dep-1",
        SyncToken: "0",
        DepositToAccountRef: { value: "10100" }, // destination bank — should NOT be touched
        Line: [
          {
            DetailType: "DepositLineDetail",
            DepositLineDetail: {
              AccountRef: { value: "40100" }, // source account — will be mutated
              PaymentMethodRef: { value: "1" },
            },
            Amount: 500.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-dep-1",
      "40200", // new source account
    );

    expect(result).toEqual({
      platform: "quickbooks",
      txnType: "Deposit",
      txnId: "txn-dep-1",
      previousAccountRef: "40100",
      newAccountRef: "40200",
    });

    // Verify deposit endpoint called with mutated per-line AccountRef AND
    // UNCHANGED top-level DepositToAccountRef
    expect(qboRequest).toHaveBeenCalledTimes(1);
    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/deposit?operation=update",
      expect.objectContaining({
        Id: "txn-dep-1",
        DepositToAccountRef: { value: "10100" }, // destination preserved
        Line: expect.arrayContaining([
          expect.objectContaining({
            DepositLineDetail: expect.objectContaining({
              AccountRef: { value: "40200" }, // per-line source mutated
            }),
          }),
        ]),
      }),
    );
  });

  it("preserves PaymentMethodRef + CheckNum + TxnType when mutating AccountRef", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-dep-2",
      platform: "quickbooks",
      txnType: "Deposit",
      previousAccountRef: "40100",
      raw: {
        Id: "txn-dep-2",
        SyncToken: "0",
        DepositToAccountRef: { value: "10100" },
        Line: [
          {
            DetailType: "DepositLineDetail",
            DepositLineDetail: {
              AccountRef: { value: "40100" },
              PaymentMethodRef: { value: "1" },
              CheckNum: "12345",
              TxnType: "Check",
            },
            Amount: 500.0,
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-dep-2",
      "40200",
    );

    expect(qboRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/deposit?operation=update",
      expect.objectContaining({
        Line: expect.arrayContaining([
          expect.objectContaining({
            DepositLineDetail: expect.objectContaining({
              AccountRef: { value: "40200" },
              PaymentMethodRef: { value: "1" },
              CheckNum: "12345",
              TxnType: "Check",
            }),
          }),
        ]),
      }),
    );
  });

  it("throws if QBO Deposit has no line items", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-dep-3",
      platform: "quickbooks",
      txnType: "Deposit",
      previousAccountRef: null,
      raw: {
        Id: "txn-dep-3",
        SyncToken: "0",
        DepositToAccountRef: { value: "10100" },
        Line: [],
      } as any,
    });

    await expect(
      updateTransactionCategory(
        MOCK_DB,
        COMPANY_ID,
        CONTACT_ID,
        "txn-dep-3",
        "40200",
      ),
    ).rejects.toThrow("QBO Deposit txn-dep-3 has no line items to categorize");
    expect(qboRequest).not.toHaveBeenCalled();
  });
});

describe("updateTransactionCategory — Xero BankTransaction handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches to Xero BankTransaction handler when lookup returns BankTransaction type", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xbt-1",
      platform: "xero",
      txnType: "BankTransaction",
      previousAccountRef: "200", // existing account code
      raw: {
        BankTransactionID: "txn-xbt-1",
        Type: "SPEND",
        Status: "AUTHORISED",
        Contact: { ContactID: "contact-1" },
        BankAccount: { AccountID: "bank-1" },
        LineItems: [
          {
            Description: "Coffee for the office",
            Quantity: 1.0,
            UnitAmount: 4.50,
            AccountCode: "200", // existing account — will be mutated
          },
        ],
      } as any,
    });
    vi.mocked(xeroRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-xbt-1",
      "429", // new account code
    );

    // Result shape verification
    expect(result).toEqual({
      platform: "xero",
      txnType: "BankTransaction",
      txnId: "txn-xbt-1",
      previousAccountRef: "200",
      newAccountRef: "429",
    });

    // Verify xeroRequest called with the right URL + body shape
    expect(xeroRequest).toHaveBeenCalledTimes(1);
    expect(xeroRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/BankTransactions", // Xero create-or-update endpoint
      {
        BankTransactions: [
          expect.objectContaining({
            BankTransactionID: "txn-xbt-1",
            LineItems: expect.arrayContaining([
              expect.objectContaining({
                AccountCode: "429", // mutated to new code
              }),
            ]),
          }),
        ],
      },
    );

    // Verify qboRequest was NOT called — this is the xero path
    expect(qboRequest).not.toHaveBeenCalled();
  });

  it("preserves LineItem fields (Description, Quantity, UnitAmount, TaxType, Tracking) during AccountCode mutation", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xbt-2",
      platform: "xero",
      txnType: "BankTransaction",
      previousAccountRef: "200",
      raw: {
        BankTransactionID: "txn-xbt-2",
        Type: "SPEND",
        LineItems: [
          {
            Description: "Equipment lease",
            Quantity: 1.0,
            UnitAmount: 250.00,
            AccountCode: "200",
            TaxType: "INPUT2",
            TaxAmount: 32.61,
            LineAmount: 250.00,
            Tracking: [
              {
                Name: "Department",
                Option: "Engineering",
              },
            ],
          },
        ],
      } as any,
    });
    vi.mocked(xeroRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-xbt-2",
      "429",
    );

    expect(xeroRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/BankTransactions",
      {
        BankTransactions: [
          expect.objectContaining({
            LineItems: expect.arrayContaining([
              expect.objectContaining({
                AccountCode: "429",
                Description: "Equipment lease",
                Quantity: 1.0,
                UnitAmount: 250.00,
                TaxType: "INPUT2",
                TaxAmount: 32.61,
                LineAmount: 250.00,
                Tracking: [
                  {
                    Name: "Department",
                    Option: "Engineering",
                  },
                ],
              }),
            ]),
          }),
        ],
      },
    );
  });

  it("throws if Xero BankTransaction has no line items", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xbt-3",
      platform: "xero",
      txnType: "BankTransaction",
      previousAccountRef: null,
      raw: {
        BankTransactionID: "txn-xbt-3",
        Type: "SPEND",
        LineItems: [],
      } as any,
    });

    await expect(
      updateTransactionCategory(
        MOCK_DB,
        COMPANY_ID,
        CONTACT_ID,
        "txn-xbt-3",
        "429",
      ),
    ).rejects.toThrow("Xero BankTransaction txn-xbt-3 has no line items to categorize");
    expect(xeroRequest).not.toHaveBeenCalled();
  });
});

describe("updateTransactionCategory — Xero Invoice/Bill shared handler", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("dispatches Invoice (Type=ACCREC) through the shared handler", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xinv-1",
      platform: "xero",
      txnType: "Invoice", // resolved by Decision 4 read dispatcher from ACCREC
      previousAccountRef: "200",
      raw: {
        InvoiceID: "txn-xinv-1",
        Type: "ACCREC", // sales Invoice — MUST be preserved on writeback
        Status: "AUTHORISED",
        InvoiceNumber: "INV-001",
        Contact: { ContactID: "contact-1" },
        LineItems: [
          {
            Description: "Consulting services",
            Quantity: 10,
            UnitAmount: 100.0,
            AccountCode: "200",
          },
        ],
      } as any,
    });
    vi.mocked(xeroRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-xinv-1",
      "260",
    );

    expect(result).toEqual({
      platform: "xero",
      txnType: "Invoice",
      txnId: "txn-xinv-1",
      previousAccountRef: "200",
      newAccountRef: "260",
    });

    // Critical assertions:
    //   - /Invoices endpoint (NOT /BankTransactions)
    //   - { Invoices: [...] } array-wrapped body
    //   - Type field PRESERVED as "ACCREC" on writeback
    //   - LineItem AccountCode mutated to "260"
    expect(xeroRequest).toHaveBeenCalledTimes(1);
    expect(xeroRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/Invoices",
      {
        Invoices: [
          expect.objectContaining({
            InvoiceID: "txn-xinv-1",
            Type: "ACCREC", // Type preservation — must NOT be dropped or changed
            LineItems: expect.arrayContaining([
              expect.objectContaining({
                AccountCode: "260",
              }),
            ]),
          }),
        ],
      },
    );
  });

  it("dispatches Bill (Type=ACCPAY) through the SAME shared handler", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xbill-1",
      platform: "xero",
      txnType: "Bill", // resolved by Decision 4 read dispatcher from ACCPAY
      previousAccountRef: "400",
      raw: {
        InvoiceID: "txn-xbill-1",
        Type: "ACCPAY", // purchase Bill — MUST be preserved on writeback
        Status: "AUTHORISED",
        InvoiceNumber: "BILL-001",
        Contact: { ContactID: "vendor-1" },
        LineItems: [
          {
            Description: "Office supplies",
            Quantity: 1,
            UnitAmount: 250.0,
            AccountCode: "400",
          },
        ],
      } as any,
    });
    vi.mocked(xeroRequest).mockResolvedValueOnce({} as any);

    const result = await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-xbill-1",
      "429",
    );

    expect(result).toEqual({
      platform: "xero",
      txnType: "Bill",
      txnId: "txn-xbill-1",
      previousAccountRef: "400",
      newAccountRef: "429",
    });

    // Same endpoint as Invoice — verifies the shared-handler / shared-endpoint
    // pattern. Type preserved as "ACCPAY".
    expect(xeroRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/Invoices",
      {
        Invoices: [
          expect.objectContaining({
            InvoiceID: "txn-xbill-1",
            Type: "ACCPAY", // Type preservation — must NOT be dropped or changed to ACCREC
            LineItems: expect.arrayContaining([
              expect.objectContaining({
                AccountCode: "429",
              }),
            ]),
          }),
        ],
      },
    );
  });

  it("preserves Invoice fields (Status, InvoiceNumber, Contact, Reference) during AccountCode mutation", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xinv-2",
      platform: "xero",
      txnType: "Invoice",
      previousAccountRef: "200",
      raw: {
        InvoiceID: "txn-xinv-2",
        Type: "ACCREC",
        Status: "AUTHORISED",
        InvoiceNumber: "INV-002",
        Reference: "PO #12345",
        Contact: { ContactID: "contact-2", Name: "ACME Corp" },
        DueDate: "2026-06-15",
        LineItems: [
          {
            Description: "Software license",
            Quantity: 1,
            UnitAmount: 1500.0,
            AccountCode: "200",
            TaxType: "OUTPUT2",
            TaxAmount: 150.0,
            LineAmount: 1500.0,
            Tracking: [
              { Name: "Region", Option: "North America" },
            ],
          },
        ],
      } as any,
    });
    vi.mocked(xeroRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-xinv-2",
      "260",
    );

    expect(xeroRequest).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "POST",
      "/Invoices",
      {
        Invoices: [
          expect.objectContaining({
            // Top-level fields preserved
            InvoiceID: "txn-xinv-2",
            Type: "ACCREC",
            Status: "AUTHORISED",
            InvoiceNumber: "INV-002",
            Reference: "PO #12345",
            Contact: { ContactID: "contact-2", Name: "ACME Corp" },
            DueDate: "2026-06-15",
            // LineItem fields preserved alongside AccountCode mutation
            LineItems: expect.arrayContaining([
              expect.objectContaining({
                AccountCode: "260",
                Description: "Software license",
                Quantity: 1,
                UnitAmount: 1500.0,
                TaxType: "OUTPUT2",
                TaxAmount: 150.0,
                LineAmount: 1500.0,
                Tracking: [
                  { Name: "Region", Option: "North America" },
                ],
              }),
            ]),
          }),
        ],
      },
    );
  });

  it("throws if Xero Invoice has no line items (error message uses txnType from lookup, NOT hardcoded 'Invoice')", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-xbill-3",
      platform: "xero",
      txnType: "Bill", // important: this is a Bill, so the error message should say "Bill"
      previousAccountRef: null,
      raw: {
        InvoiceID: "txn-xbill-3",
        Type: "ACCPAY",
        LineItems: [],
      } as any,
    });

    await expect(
      updateTransactionCategory(
        MOCK_DB,
        COMPANY_ID,
        CONTACT_ID,
        "txn-xbill-3",
        "429",
      ),
    ).rejects.toThrow("Xero Bill txn-xbill-3 has no line items to categorize");
    // Verify the error message used "Bill" (from txnType), NOT "Invoice"
    // (which would be wrong since the same handler serves both types)
    expect(xeroRequest).not.toHaveBeenCalled();
  });
});

describe("updateTransactionCategory — hintedType parameter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("plumbs hintedType through to getTransactionById when provided", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-hint-1",
      platform: "quickbooks",
      txnType: "Purchase",
      previousAccountRef: "60100",
      raw: {
        Id: "txn-hint-1",
        SyncToken: "0",
        Line: [
          {
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
            },
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-hint-1",
      "60200",
      "Purchase", // explicit hint
    );

    // Verify getTransactionById was called with the hint as the 5th positional arg
    expect(getTransactionById).toHaveBeenCalledTimes(1);
    expect(getTransactionById).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-hint-1",
      "Purchase", // <-- the hint
    );
  });

  it("calls getTransactionById without hint when hintedType is omitted (backward-compatible)", async () => {
    vi.mocked(getTransactionById).mockResolvedValueOnce({
      txnId: "txn-nohint-1",
      platform: "quickbooks",
      txnType: "Bill",
      previousAccountRef: "60100",
      raw: {
        Id: "txn-nohint-1",
        SyncToken: "0",
        Line: [
          {
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: "60100" },
            },
          },
        ],
      } as any,
    });
    vi.mocked(qboRequest).mockResolvedValueOnce({} as any);

    await updateTransactionCategory(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-nohint-1",
      "60200",
      // hintedType intentionally omitted
    );

    // Verify getTransactionById was called WITHOUT a 5th arg (or with undefined)
    expect(getTransactionById).toHaveBeenCalledTimes(1);
    expect(getTransactionById).toHaveBeenCalledWith(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "txn-nohint-1",
      undefined, // <-- no hint
    );
  });
});
