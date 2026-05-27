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

import { getTransactionById } from "./transaction-lookup.js";
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
