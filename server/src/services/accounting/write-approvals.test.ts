import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./transaction-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transaction-write.js")>();
  return {
    ...actual,
    updateTransactionCategory: vi.fn(),
  };
});

vi.mock("./index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index.js")>();
  return {
    ...actual,
    reconcilePayment: vi.fn(),
    // Piece I: extend the qbo namespace mock with spies for createInvoice +
    // findOrCreateCustomer. Spreading actual.qbo preserves any other
    // qbo.* methods consumed elsewhere in the dispatcher.
    qbo: {
      ...actual.qbo,
      createInvoice: vi.fn(),
      findOrCreateCustomer: vi.fn(),
    },
  };
});

vi.mock("./payments-helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./payments-helpers.js")>();
  return {
    ...actual,
    resolveEntityRefByPlatform: vi.fn(),
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
import { qbo, reconcilePayment, PaymentReferenceError } from "./index.js";
import {
  resolveEntityRefByPlatform,
  EntityRefResolutionError,
} from "./payments-helpers.js";
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

describe("executeApprovedAccountingWrite — accounting.payment.threshold_exceeded (Piece E)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("executes payment approval on replay — happy path (write succeeds)", async () => {
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "quickbooks",
      ref: { customerId: "cust-payment-1" },
    });
    vi.mocked(reconcilePayment).mockResolvedValueOnce({
      platform: "quickbooks",
      paymentId: "qbo-pay-789",
      invoiceId: "inv-payment-1",
      amount: 1500000,
      customerId: "cust-payment-1",
      accountId: undefined,
      paymentDate: "2026-05-27",
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-payment-1",
        amount: 1500000,
        entityRef: "cust-payment-1",
        paymentDate: "2026-05-27",
        thresholdAmount: 1000000,
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(true);
    expect(result.action).toBe("write_executed");
    expect(result.upstreamResult).toEqual({
      platform: "quickbooks",
      paymentId: "qbo-pay-789",
      invoiceId: "inv-payment-1",
      amount: 1500000,
      customerId: "cust-payment-1",
      accountId: undefined,
      paymentDate: "2026-05-27",
    });
    expect(result.message).toContain("qbo-pay-789");
    expect(result.message).toContain("quickbooks");

    // Verify the resolver + dispatcher were called with payload values
    expect(resolveEntityRefByPlatform).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test",
      "contact-test",
      "cust-payment-1",
    );
    expect(reconcilePayment).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test",
      "contact-test",
      "inv-payment-1",
      1500000,
      { customerId: "cust-payment-1" },
      "2026-05-27",
    );
  });

  it("returns write_failed_replay when payload is missing entityRef", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-payment-2",
        amount: 1500000,
        // entityRef intentionally omitted
        thresholdAmount: 1000000,
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("missing entityRef");

    // Verify neither resolver nor dispatcher was called
    expect(resolveEntityRefByPlatform).not.toHaveBeenCalled();
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  it("returns write_failed_replay when resolveEntityRefByPlatform throws EntityRefResolutionError", async () => {
    vi.mocked(resolveEntityRefByPlatform).mockRejectedValueOnce(
      new EntityRefResolutionError(
        "company-test",
        "contact-test",
        "no_connection_found",
      ),
    );

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-payment-3",
        amount: 1500000,
        entityRef: "cust-payment-3",
        thresholdAmount: 1000000,
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("entity ref resolution failed");
    expect(result.message).toContain("no_connection_found");

    // reconcilePayment must NOT have been called since the resolver failed first
    expect(reconcilePayment).not.toHaveBeenCalled();
  });

  it("returns write_failed_replay when reconcilePayment throws PaymentReferenceError", async () => {
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "quickbooks",
      ref: { customerId: "cust-payment-4" },
    });
    vi.mocked(reconcilePayment).mockRejectedValueOnce(
      new PaymentReferenceError(
        "company-test",
        "contact-test",
        "quickbooks",
        { customerId: "cust-payment-4" },
        "wrong_ref_for_platform",
      ),
    );

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-payment-4",
        amount: 1500000,
        entityRef: "cust-payment-4",
        thresholdAmount: 1000000,
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("payment reference invalid");
    expect(result.message).toContain("quickbooks");
    expect(result.message).toContain("wrong_ref_for_platform");
  });

  it("propagates unknown errors (e.g., HttpResponseError from platform) instead of swallowing them", async () => {
    vi.mocked(resolveEntityRefByPlatform).mockResolvedValueOnce({
      platform: "xero",
      ref: { accountId: "acct-payment-5" },
    });
    const platformError = new Error("Xero Payment failed: 503 Service Unavailable");
    vi.mocked(reconcilePayment).mockRejectedValueOnce(platformError);

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
      {
        requestType: "POST /api/accounting/v1/payments",
        companyId: "company-test",
        contactId: "contact-test",
        invoiceId: "inv-payment-5",
        amount: 1500000,
        entityRef: "acct-payment-5",
        thresholdAmount: 1000000,
      },
    );

    await expect(
      executeApprovedAccountingWrite(MOCK_DB, approval),
    ).rejects.toBe(platformError);
  });
});

describe("executeApprovedAccountingWrite — accounting.invoice.dedupe_ambiguous (Piece I)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("executes dedupe approval on replay — happy path (createInvoice with matchedCustomerId, no findOrCreateCustomer call)", async () => {
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-100",
      invoiceNumber: "INV-1001",
      totalAmt: 59900,
      dueDate: "2026-06-12",
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 59900 }],
        dueDate: "2026-06-12",
        dedupeDecision: {
          matchedCustomerId: "cust-resolved-1",
          matchType: "name_only",
          confidence: 0.3,
        },
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(true);
    expect(result.action).toBe("write_executed");
    expect(result.upstreamResult).toEqual({
      invoiceId: "qbo-inv-100",
      invoiceNumber: "INV-1001",
      totalAmt: 59900,
      dueDate: "2026-06-12",
      customerRef: "cust-resolved-1",
    });
    expect(result.message).toContain("qbo-inv-100");
    expect(result.message).toContain("cust-resolved-1");

    // Verify createInvoice called with QBO books key null + matchedCustomerId
    expect(qbo.createInvoice).toHaveBeenCalledTimes(1);
    expect(qbo.createInvoice).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test",
      null, // QBO books key, NOT the GHL contactId
      "cust-resolved-1",
      [{ description: "Foundation tier — May 2026", amount: 59900 }],
      "2026-06-12",
    );

    // Q-inv-2-β: dedupe replay does NOT re-run findOrCreateCustomer
    expect(qbo.findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("returns write_failed_replay when payload is missing dedupeDecision.matchedCustomerId", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 59900 }],
        // dedupeDecision intentionally omitted
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("matchedCustomerId");
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("propagates unknown errors from createInvoice (HttpResponseError-style)", async () => {
    const platformError = new Error("QBO Invoice create failed: 502 Bad Gateway");
    vi.mocked(qbo.createInvoice).mockRejectedValueOnce(platformError);

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 59900 }],
        dueDate: "2026-06-12",
        dedupeDecision: {
          matchedCustomerId: "cust-resolved-1",
          matchType: "name_only",
          confidence: 0.3,
        },
      },
    );

    await expect(
      executeApprovedAccountingWrite(MOCK_DB, approval),
    ).rejects.toBe(platformError);
  });
});

describe("executeApprovedAccountingWrite — accounting.invoice.pricing_mismatch (Piece I)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("re-resolves customer (found_by_email) and creates invoice — happy path", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-found-by-email-1",
      action: "found_by_email",
    });
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-200",
      invoiceNumber: "INV-2001",
      totalAmt: 60000,
      dueDate: "2026-06-12",
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — overridden", amount: 60000 }],
        dueDate: "2026-06-12",
        pricingDecision: {
          sentAmountCents: 60000,
          expectedAmountCents: 59900,
          isCharter: false,
          deltaCents: 100,
          deltaPercent: 0.17,
        },
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(true);
    expect(result.action).toBe("write_executed");
    expect(result.upstreamResult).toEqual({
      invoiceId: "qbo-inv-200",
      invoiceNumber: "INV-2001",
      totalAmt: 60000,
      dueDate: "2026-06-12",
      customerRef: "cust-found-by-email-1",
      customerResolveAction: "found_by_email",
    });
    expect(result.message).toContain("qbo-inv-200");
    expect(result.message).toContain("found_by_email");

    // REVISED Q-inv-3-β: findOrCreateCustomer WAS called (customer re-resolved)
    expect(qbo.findOrCreateCustomer).toHaveBeenCalledTimes(1);
    expect(qbo.findOrCreateCustomer).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test",
      null, // QBO books key
      "ACME Corp",
      "billing@acme.example",
    );
    // Then createInvoice with the resolved id
    expect(qbo.createInvoice).toHaveBeenCalledWith(
      MOCK_DB,
      "company-test",
      null,
      "cust-found-by-email-1",
      [{ description: "Foundation tier — overridden", amount: 60000 }],
      "2026-06-12",
    );
  });

  it("re-resolves customer (created_new) and creates invoice", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-new-1",
      action: "created_new",
    });
    vi.mocked(qbo.createInvoice).mockResolvedValueOnce({
      invoiceId: "qbo-inv-201",
      invoiceNumber: "INV-2002",
      totalAmt: 60000,
      dueDate: "2026-06-12",
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "New Client LLC",
        customerEmail: "billing@newclient.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 60000 }],
        dueDate: "2026-06-12",
        pricingDecision: {
          sentAmountCents: 60000,
          expectedAmountCents: 59900,
          isCharter: false,
          deltaCents: 100,
          deltaPercent: 0.17,
        },
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(true);
    expect(result.action).toBe("write_executed");
    expect((result.upstreamResult as Record<string, unknown>).customerResolveAction).toBe("created_new");
  });

  it("returns write_failed_replay when re-resolve returns ambiguous (load-bearing drift test, Q-inv-3-β)", async () => {
    // The locked conservative path per REVISED Q-inv-3-β (commit 7ac02b90):
    // if findOrCreateCustomer surfaces a fresh dedupe ambiguity on replay,
    // the pricing approval does NOT authorize resolving it. Escalate, do
    // NOT call createInvoice.
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-ambig-1",
      action: "ambiguous_name_only",
      matchDetails: {
        submittedName: "ACME Corp",
        submittedEmail: "billing@acme.example",
        storedName: "ACME Corp",
        storedEmail: "different@acme.example",
      },
    });

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 60000 }],
        dueDate: "2026-06-12",
        pricingDecision: {
          sentAmountCents: 60000,
          expectedAmountCents: 59900,
          isCharter: false,
          deltaCents: 100,
          deltaPercent: 0.17,
        },
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("ambiguous_name_only");
    expect(result.message).toContain("drifted");
    expect(result.message).toContain("re-submit");

    // Load-bearing: createInvoice MUST NOT be called when dedupe state drifted
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("propagates unknown errors from createInvoice (after successful resolve)", async () => {
    vi.mocked(qbo.findOrCreateCustomer).mockResolvedValueOnce({
      customerId: "cust-found-1",
      action: "found_by_email",
    });
    const platformError = new Error("QBO Invoice create failed: 503 Service Unavailable");
    vi.mocked(qbo.createInvoice).mockRejectedValueOnce(platformError);

    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 60000 }],
        dueDate: "2026-06-12",
        pricingDecision: {
          sentAmountCents: 60000,
          expectedAmountCents: 59900,
          isCharter: false,
          deltaCents: 100,
          deltaPercent: 0.17,
        },
      },
    );

    await expect(
      executeApprovedAccountingWrite(MOCK_DB, approval),
    ).rejects.toBe(platformError);
  });

  it("returns write_failed_replay when payload is missing customerName", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        // customerName intentionally omitted
        customerEmail: "billing@acme.example",
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 60000 }],
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("customerName");
    expect(qbo.findOrCreateCustomer).not.toHaveBeenCalled();
    expect(qbo.createInvoice).not.toHaveBeenCalled();
  });

  it("returns write_failed_replay when payload is missing customerEmail", async () => {
    const approval = makeApproval(
      ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
      {
        requestType: "POST /api/accounting/v1/invoices",
        companyId: "company-test",
        contactId: "ghl-contact-test",
        customerName: "ACME Corp",
        // customerEmail intentionally omitted
        serviceTier: "Foundation",
        billingPeriod: { start: "2026-05-01", end: "2026-05-31" },
        lineItems: [{ description: "Foundation tier — May 2026", amount: 60000 }],
      },
    );

    const result = await executeApprovedAccountingWrite(MOCK_DB, approval);

    expect(result.executed).toBe(false);
    expect(result.action).toBe("write_failed_replay");
    expect(result.message).toContain("customerEmail");
    expect(qbo.findOrCreateCustomer).not.toHaveBeenCalled();
  });
});
