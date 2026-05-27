import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./transaction-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transaction-write.js")>();
  return {
    ...actual,
    updateTransactionCategory: vi.fn(),
  };
});

import {
  executeApprovedAccountingWrite,
  isAccountingApprovalType,
  ACCOUNTING_APPROVAL_TYPES,
} from "./write-approvals.js";
import {
  updateTransactionCategory,
  TransactionTypeNotCategorizableError,
} from "./transaction-write.js";
import { TransactionNotFoundError } from "./transaction-lookup.js";
import type { approvals } from "@paperclipai/db";

// Mock DB — dispatcher passes db through to updateTransactionCategory; the
// dispatcher itself is mocked, so the db value never gets exercised.
const MOCK_DB = {} as never;

function makeApproval(
  type: string,
  payload: Record<string, unknown>,
): typeof approvals.$inferSelect {
  const now = new Date();
  return {
    id: "approval-test-id",
    companyId: "company-test",
    type,
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "approved",
    payload,
    decisionNote: null,
    decidedByUserId: "test-user",
    decidedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe("isAccountingApprovalType", () => {
  it("returns true for accounting.* types", () => {
    expect(isAccountingApprovalType(ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED)).toBe(true);
    expect(isAccountingApprovalType(ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS)).toBe(true);
    expect(isAccountingApprovalType(ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH)).toBe(true);
    expect(isAccountingApprovalType(ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS)).toBe(true);
  });

  it("returns false for non-accounting types", () => {
    expect(isAccountingApprovalType("hire_agent")).toBe(false);
    expect(isAccountingApprovalType("budget_increase")).toBe(false);
    expect(isAccountingApprovalType("")).toBe(false);
  });

  it("returns false for types that look similar but don't start with accounting.", () => {
    expect(isAccountingApprovalType("accountingstuff")).toBe(false);
    expect(isAccountingApprovalType("my.accounting.thing")).toBe(false);
  });
});

describe("executeApprovedAccountingWrite", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("routes payment.threshold_exceeded to the payment stub", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-1",
        amount: 1500000,
        thresholdAmount: 1000000,
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("stub_logged");
    expect(result.message).toContain("Phase 4c.5");
  });

  it("routes invoice.dedupe_ambiguous to the invoice stub", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "contact-test",
        customerName: "Test Co",
        customerEmail: "test@example.com",
        serviceTier: "Foundation",
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("stub_logged");
    expect(result.message).toContain("Phase 4c.5");
  });

  it("routes invoice.pricing_mismatch to the invoice stub", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "contact-test",
        customerName: "Test Co",
        customerEmail: "test@example.com",
        serviceTier: "Growth Engine",
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("stub_logged");
  });

  it("executes transaction.category_with_unknown_previous on approval — happy path (write succeeds on replay)", async () => {
    vi.mocked(updateTransactionCategory).mockResolvedValueOnce({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-123",
      previousAccountRef: "60100",
      newAccountRef: "6000-Rent",
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
      {
        requestType: "POST /api/accounting/v1/transactions/:txnId/category",
        companyId: "company-test",
        contactId: "contact-test",
        txnId: "txn-123",
        newAccountRef: "6000-Rent",
        unknownPreviousReason: "platform_lookup_unavailable",
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(true);
    expect(result.action).toBe("write_executed");
    expect(result.upstreamResult).toEqual({
      platform: "quickbooks",
      txnType: "Purchase",
      txnId: "txn-123",
      previousAccountRef: "60100",
      newAccountRef: "6000-Rent",
    });
    expect(result.message).toContain("quickbooks");
    expect(result.message).toContain("Purchase");

    // Verify the dispatcher was called with payload values (NOT with hintedType)
    expect(updateTransactionCategory).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test", // from approval.companyId
      "contact-test", // from payload.contactId
      "txn-123",
      "6000-Rent",
    );
  });

  it("returns write_failed_replay when transaction is still not found on replay", async () => {
    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(
      new TransactionNotFoundError(
        "quickbooks",
        "txn-123",
        ["Purchase", "Bill", "JournalEntry", "Deposit", "BillPayment", "Payment", "Invoice"],
      ),
    );

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
      {
        requestType: "POST /api/accounting/v1/transactions/:txnId/category",
        companyId: "company-test",
        contactId: "contact-test",
        txnId: "txn-123",
        newAccountRef: "6000-Rent",
        unknownPreviousReason: "transaction_type_unknown",
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("txn-123");
    expect(result.message).toContain("still not found");
    expect(result.upstreamResult).toBeUndefined();
  });

  it("returns write_failed_replay when resolved type is not categorizable (excluded type)", async () => {
    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(
      new TransactionTypeNotCategorizableError(
        "quickbooks",
        "BillPayment", // an excluded type per Decision 5
        "txn-456",
      ),
    );

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
      {
        requestType: "POST /api/accounting/v1/transactions/:txnId/category",
        companyId: "company-test",
        contactId: "contact-test",
        txnId: "txn-456",
        newAccountRef: "6000-Rent",
        unknownPreviousReason: "transaction_type_unknown",
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("txn-456");
    expect(result.message).toContain("BillPayment");
    expect(result.message).toContain("not support category updates");
    expect(result.upstreamResult).toBeUndefined();
  });

  it("propagates unknown errors (e.g., HttpResponseError from platform) instead of swallowing them", async () => {
    const platformError = new Error("Platform write failed: 503 Service Unavailable");
    vi.mocked(updateTransactionCategory).mockRejectedValueOnce(platformError);

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
      {
        requestType: "POST /api/accounting/v1/transactions/:txnId/category",
        companyId: "company-test",
        contactId: "contact-test",
        txnId: "txn-789",
        newAccountRef: "6000-Rent",
        unknownPreviousReason: "platform_lookup_unavailable",
      },
    );

    // The error should propagate, not be caught silently
    await expect(executeApprovedAccountingWrite(MOCK_DB, approval)).rejects.toBe(platformError);
  });

  it("returns skip_unknown_type for an unrecognized accounting.* type", async () => {
    const approval = makeApproval(
      "accounting.unknown.future_type",
      { someField: "someValue" },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("skip_unknown_type");
    expect(result.message).toContain("Unknown accounting approval type");
  });

  it("returns skip_unknown_type for completely non-accounting type (defensive)", async () => {
    // Real callers should check isAccountingApprovalType first, but the
    // dispatcher itself should still degrade gracefully if mis-called.
    const approval = makeApproval("hire_agent", {});

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("skip_unknown_type");
  });
});

describe("ACCOUNTING_APPROVAL_TYPES constants", () => {
  it("all constants are dot-namespaced under accounting.", () => {
    for (const value of Object.values(ACCOUNTING_APPROVAL_TYPES)) {
      expect(value).toMatch(/^accounting\./);
    }
  });

  it("contains exactly 4 types", () => {
    expect(Object.keys(ACCOUNTING_APPROVAL_TYPES)).toHaveLength(4);
  });
});
