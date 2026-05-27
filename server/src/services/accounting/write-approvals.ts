import type { Db, approvals } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

// Write-approval dispatcher for Phase 4c safety architecture per ADR-003 Q3.
//
// When a write endpoint detects a safety condition that requires human
// approval (threshold exceeded, ambiguous customer match, pricing mismatch,
// missing transaction context), it creates an approval row with one of the
// types below instead of executing the write. When the approval is
// subsequently approved (by a human reviewer via approvalService.approve()),
// this dispatcher executes the deferred write using the payload data.
//
// The dispatcher is wired into approvalService.approve() — when the approval
// type starts with 'accounting.', approve() calls executeApprovedAccountingWrite()
// after updating the approval status. This mirrors how 'hire_agent' approvals
// trigger agent activation today.
//
// IMPORTANT: This module deliberately does NOT execute writes against QBO/Xero
// in Phase 4c.4. The dispatcher logs the approved-write event and updates
// the approval payload with "executed" status, but the actual upstream write
// is performed by Phase 4c.5 when the re-shipped write endpoints exist.
// In Phase 4c.4, executeApprovedAccountingWrite() functions as a routing/logging
// stub that records what WOULD be executed; Phase 4c.5 wires it to the real
// service-layer write functions.

// =============================================================================
// Approval type constants (dot-namespaced per ADR-003 Q1)
// =============================================================================

export const ACCOUNTING_APPROVAL_TYPES = {
  PAYMENT_THRESHOLD_EXCEEDED: "accounting.payment.threshold_exceeded",
  INVOICE_DEDUPE_AMBIGUOUS: "accounting.invoice.dedupe_ambiguous",
  INVOICE_PRICING_MISMATCH: "accounting.invoice.pricing_mismatch",
  TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS: "accounting.transaction.category_with_unknown_previous",
} as const;

export type AccountingApprovalType =
  typeof ACCOUNTING_APPROVAL_TYPES[keyof typeof ACCOUNTING_APPROVAL_TYPES];

// Returns true if the given approval type is one this dispatcher handles.
// Used by approvalService.approve() to decide whether to call the dispatcher.
export function isAccountingApprovalType(type: string): type is AccountingApprovalType {
  return type.startsWith("accounting.");
}

// =============================================================================
// Payload type definitions per ADR-003 Q2
// =============================================================================

// Common fields present in every accounting approval payload
interface BaseAccountingPayload {
  companyId: string;
  contactId: string;
  reason?: string;
  idempotencyKey?: string;
}

export interface PaymentThresholdExceededPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/payments";
  invoiceId: string;
  amount: number;                              // in cents
  paymentDate?: string;                        // ISO date (YYYY-MM-DD)
  entityRef?: string;
  thresholdAmount: number;                     // what threshold was exceeded (cents)
  expectedRange?: { min: number; max: number }; // for invoice-balance comparison
}

export interface InvoiceDedupeAmbiguousPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/invoices";
  customerName: string;
  customerEmail: string;
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up";
  billingPeriod: { start: string; end: string };
  lineItems: Array<{ description: string; amount: number }>;
  dueDate?: string;
  dedupeDecision: {
    matchedCustomerId: string;
    matchType: "name_only" | "email_only_different_name";
    confidence: number;
  };
}

export interface InvoicePricingMismatchPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/invoices";
  customerName: string;
  customerEmail: string;
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up";
  billingPeriod: { start: string; end: string };
  lineItems: Array<{ description: string; amount: number }>;
  dueDate?: string;
  pricingDecision: {
    sentAmountCents: number;
    expectedAmountCents: number;
    isCharter: boolean;
    deltaCents: number;
    deltaPercent: number;
  };
}

export interface TransactionCategoryUnknownPreviousPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/transactions/:txnId/category";
  txnId: string;
  newAccountRef: string;
  unknownPreviousReason: "platform_lookup_unavailable" | "transaction_type_unknown";
}

export type AccountingApprovalPayload =
  | PaymentThresholdExceededPayload
  | InvoiceDedupeAmbiguousPayload
  | InvoicePricingMismatchPayload
  | TransactionCategoryUnknownPreviousPayload;

// =============================================================================
// Dispatcher
// =============================================================================

export interface ExecuteApprovalResult {
  // Whether the deferred write was actually performed
  executed: boolean;
  // What the dispatcher did (for audit logging from the approval flow)
  action: "stub_logged" | "write_executed" | "skip_unknown_type";
  // Optional: result of the upstream write (Phase 4c.5 will populate this)
  upstreamResult?: Record<string, unknown>;
  // Human-readable description
  message: string;
}

// Dispatcher: routes an approved accounting approval to the correct
// downstream handler. Currently in Phase 4c.4 this is a stub that logs
// the event; Phase 4c.5 wires it to the real write functions.
//
// Returns information about what was done. Callers (approvalService.approve())
// can use this to construct activity_log entries.
export async function executeApprovedAccountingWrite(
  db: Db,
  approval: typeof approvals.$inferSelect,
): Promise<ExecuteApprovalResult> {
  const type = approval.type;
  const payload = approval.payload as Record<string, unknown>;

  // Stub mode for Phase 4c.4 — Phase 4c.5 will replace each case with the
  // actual upstream write call via updateTransactionCategory from
  // services/accounting/transaction-write.ts (Decision 5 dispatcher).
  switch (type) {
    case ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED: {
      logger.info(
        {
          approvalId: approval.id,
          companyId: approval.companyId,
          approvalType: type,
          invoiceId: payload.invoiceId,
          amount: payload.amount,
        },
        "[Phase 4c.4 stub] Payment approval executed — Phase 4c.5 will perform the actual write",
      );
      return {
        executed: false,
        action: "stub_logged",
        message: "Payment write deferred to Phase 4c.5 implementation",
      };
    }

    case ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS:
    case ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH: {
      logger.info(
        {
          approvalId: approval.id,
          companyId: approval.companyId,
          approvalType: type,
          customerName: payload.customerName,
        },
        "[Phase 4c.4 stub] Invoice approval executed — Phase 4c.5 will perform the actual write",
      );
      return {
        executed: false,
        action: "stub_logged",
        message: "Invoice write deferred to Phase 4c.5 implementation",
      };
    }

    case ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS: {
      logger.info(
        {
          approvalId: approval.id,
          companyId: approval.companyId,
          approvalType: type,
          txnId: payload.txnId,
          newAccountRef: payload.newAccountRef,
        },
        "[Phase 4c.4 stub] Transaction category approval executed — Phase 4c.5 will perform the actual write",
      );
      return {
        executed: false,
        action: "stub_logged",
        message: "Transaction category write deferred to Phase 4c.5 implementation",
      };
    }

    default: {
      logger.warn(
        { approvalId: approval.id, approvalType: type },
        "Unknown accounting approval type — dispatcher cannot route",
      );
      return {
        executed: false,
        action: "skip_unknown_type",
        message: `Unknown accounting approval type: ${type}`,
      };
    }
  }
}
