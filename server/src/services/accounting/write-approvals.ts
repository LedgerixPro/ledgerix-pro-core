import type { Db, approvals } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  updateTransactionCategory,
  TransactionTypeNotCategorizableError,
} from "./transaction-write.js";
import { TransactionNotFoundError } from "./transaction-lookup.js";
import {
  reconcilePayment,
  PaymentReferenceError,
} from "./index.js";
import {
  resolveEntityRefByPlatform,
  EntityRefResolutionError,
} from "./payments-helpers.js";

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
// PHASE 4c.5 WIRING STATUS (2026-05-27):
//   - accounting.transaction.category_with_unknown_previous: WIRED to the
//     Decision 5 dispatcher (updateTransactionCategory). Execute replays
//     the original POST /transactions/:txnId/category request from the
//     payload per ADR-003 Q2 design intent.
//   - accounting.payment.threshold_exceeded: WIRED to the Decision 6
//     dispatcher (reconcilePayment) via the resolveEntityRefByPlatform
//     translation helper (Piece F). Execute replays the original
//     POST /api/accounting/v1/payments request from the payload. Three
//     outcomes parallel to Piece B: success → write_executed; entity ref
//     resolution failure or payment reference validation failure →
//     write_failed_replay; unknown errors propagate.
//   - accounting.invoice.dedupe_ambiguous: STILL A STUB. Will be wired
//     when the POST /invoices endpoint is re-implemented (Invoice
//     endpoint design pending — Q1/Q2 prerequisites now satisfied).
//   - accounting.invoice.pricing_mismatch: STILL A STUB. Same as above.

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
  // What the dispatcher did (for audit logging from the approval flow):
  //   - "stub_logged": Phase 4c.4 placeholder — execution deferred to
  //     Phase 4c.5 implementation (will be removed as remaining approval
  //     types are wired)
  //   - "write_executed": dispatcher reached the real write function and
  //     it completed successfully
  //   - "write_failed_replay": dispatcher tried to execute the write but
  //     the underlying operation failed in a way that doesn't crash the
  //     approval flow (e.g., transaction still missing on replay, type
  //     not categorizable). Caller logs this and surfaces it to the
  //     approver UI for manual intervention.
  //   - "skip_unknown_type": the approval type isn't one this dispatcher
  //     handles (caller should route elsewhere or warn)
  action:
    | "stub_logged"
    | "write_executed"
    | "write_failed_replay"
    | "skip_unknown_type";
  // Optional: result of the upstream write (only set when action ===
  // "write_executed"). Contains platform, txnType, txnId,
  // previousAccountRef, newAccountRef for category updates; shape varies
  // by approval type.
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

  // Phase 4c.5 wiring in progress — see module-level header for per-type
  // wiring status. The transaction-category case (Decision 5) and the
  // payment-threshold case (Decision 6) are both fully wired. The invoice
  // cases (dedupe_ambiguous + pricing_mismatch) remain Phase 4c.4 stubs
  // pending the Invoice endpoint design + implementation.
  switch (type) {
    case ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED: {
      // Phase 4c.5 Decision 6 Piece E wiring (2026-05-27): replay the
      // original POST /api/accounting/v1/payments request using the
      // reconcilePayment dispatcher (Piece D) via the
      // resolveEntityRefByPlatform translation helper (Piece F).
      //
      // Per ADR-003 Q2 design intent ("payloads must be self-sufficient...
      // the request that arrived must be re-executable from the payload
      // alone"), execution = replay. Same pattern as Piece B's
      // TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS wiring (commit 001d547f).
      //
      // Three outcomes parallel to Piece B:
      //   1. Success: dispatcher succeeded; return action: "write_executed"
      //      with upstreamResult containing the ReconcilePaymentResult
      //      audit-trail data.
      //   2. Payment-specific failure (EntityRefResolutionError or
      //      PaymentReferenceError): the payload's entityRef cannot be
      //      validly mapped to a service call for the current connection
      //      state. Return action: "write_failed_replay" with a message
      //      surfacing the reason — manual intervention required.
      //   3. Unknown errors propagate (HttpResponseError from QBO/Xero,
      //      network failures, etc.). The approval flow's outer error
      //      handler captures them. We do NOT swallow unknown errors.
      //
      // The payload's entityRef is REQUIRED for replay — if the route
      // handler created an approval row without entityRef populated, the
      // replay cannot proceed. This guard is defensive: in practice the
      // route handler (Piece G) MUST populate entityRef in the payload
      // because it's the only way to identify which customer/account the
      // payment applies to.
      const rawEntityRef = payload.entityRef as string | undefined;
      if (!rawEntityRef || typeof rawEntityRef !== "string" || rawEntityRef.length === 0) {
        logger.warn(
          {
            approvalId: approval.id,
            companyId: approval.companyId,
            approvalType: type,
          },
          "Payment approval execution failed — payload missing entityRef",
        );
        return {
          executed: false,
          action: "write_failed_replay",
          message:
            `Payment approval payload is missing entityRef. Replay cannot proceed; ` +
            `manual intervention required (the original request may have been malformed).`,
        };
      }

      const contactId = (payload.contactId as string | null | undefined) ?? null;
      const invoiceId = payload.invoiceId as string;
      const amount = payload.amount as number;
      const paymentDate = payload.paymentDate as string | undefined;

      try {
        // Step 1: resolve entityRef → split ref via the Piece F helper.
        // This performs the platform lookup and the QBO-vs-Xero translation
        // in one atomic step. Identical translation logic to the route
        // handler (Piece G) — both call sites use the same resolver.
        const resolved = await resolveEntityRefByPlatform(
          db,
          approval.companyId,
          contactId,
          rawEntityRef,
        );

        // Step 2: replay the payment via reconcilePayment with the resolved
        // split ref. reconcilePayment performs its own platform lookup
        // internally (redundant with the resolver's lookup but defensive —
        // both produce the same result for the same input). Future
        // optimization: pass the resolved platform through to skip the
        // second lookup; for now, correctness over micro-optimization.
        const writeResult = await reconcilePayment(
          db,
          approval.companyId,
          contactId,
          invoiceId,
          amount,
          resolved.ref,
          paymentDate,
        );

        logger.info(
          {
            approvalId: approval.id,
            companyId: approval.companyId,
            approvalType: type,
            invoiceId,
            amount,
            platform: writeResult.platform,
            paymentId: writeResult.paymentId,
          },
          "Payment approval executed — write succeeded on replay",
        );

        return {
          executed: true,
          action: "write_executed",
          upstreamResult: {
            platform: writeResult.platform,
            paymentId: writeResult.paymentId,
            invoiceId: writeResult.invoiceId,
            amount: writeResult.amount,
            customerId: writeResult.customerId,
            accountId: writeResult.accountId,
            paymentDate: writeResult.paymentDate,
          },
          message:
            `Payment ${writeResult.paymentId} applied on platform ${writeResult.platform} ` +
            `for invoice ${writeResult.invoiceId} (amount: ${writeResult.amount} cents)`,
        };
      } catch (err) {
        if (err instanceof EntityRefResolutionError) {
          logger.warn(
            {
              approvalId: approval.id,
              companyId: approval.companyId,
              approvalType: type,
              invoiceId,
              amount,
              entityRefReason: err.reason,
              resolvedPlatform: err.resolvedPlatform,
            },
            "Payment approval execution failed — entity ref resolution failed",
          );
          return {
            executed: false,
            action: "write_failed_replay",
            message:
              `Payment approval cannot be executed: entity ref resolution failed ` +
              `(reason: ${err.reason}). The accounting connection may have changed since ` +
              `the approval was created. Manual intervention required.`,
          };
        }

        if (err instanceof PaymentReferenceError) {
          logger.warn(
            {
              approvalId: approval.id,
              companyId: approval.companyId,
              approvalType: type,
              invoiceId,
              amount,
              paymentRefReason: err.reason,
              resolvedPlatform: err.platform,
            },
            "Payment approval execution failed — payment reference validation failed",
          );
          return {
            executed: false,
            action: "write_failed_replay",
            message:
              `Payment approval cannot be executed: payment reference invalid for platform ` +
              `${err.platform} (reason: ${err.reason}). Manual intervention required.`,
          };
        }

        // Any other error (HttpResponseError, network failure, platform 5xx,
        // etc.) propagates as-is. The approval flow's outer error handler
        // will log it. We don't swallow unknown errors silently — matches
        // Piece B's pattern.
        throw err;
      }
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
      // Phase 4c.5 Decision 5 wiring (2026-05-27): replay the original
      // POST /transactions/:txnId/category request using the
      // updateTransactionCategory dispatcher. Per ADR-003 Q2 design
      // intent ("payloads must be self-sufficient... the request that
      // arrived must be re-executable from the payload alone"),
      // execution = replay.
      //
      // Three distinct outcomes:
      //   1. Success: dispatcher resolved the txn (which it couldn't at
      //      original-request time) and the write succeeded. This happens
      //      when Decision 4 coverage was extended between approval
      //      creation and approval execution, OR when the original failure
      //      was transient (auth refresh, network blip).
      //   2. Still not found: TransactionNotFoundError thrown again —
      //      the txn type is still outside Decision 4 coverage. Manual
      //      intervention required. Return action: "write_failed_replay".
      //   3. Type not categorizable: txn now resolves, but to a type in
      //      Decision 5's excluded list (BillPayment, Payment, etc.).
      //      Manual intervention required. Return action: "write_failed_replay".
      //
      // We do NOT pass hintedType here — the original request didn't have
      // type info (that's why the approval got created), and we have no
      // mechanism for the human approver to supply it. Multi-type probe is
      // the correct fallback.
      try {
        const result = await updateTransactionCategory(
          db,
          approval.companyId,
          (payload.contactId as string | null | undefined) ?? null,
          payload.txnId as string,
          payload.newAccountRef as string,
        );
        logger.info(
          {
            approvalId: approval.id,
            companyId: approval.companyId,
            approvalType: type,
            txnId: payload.txnId,
            platform: result.platform,
            txnType: result.txnType,
            previousAccountRef: result.previousAccountRef,
            newAccountRef: result.newAccountRef,
          },
          "Transaction category approval executed — write succeeded on replay",
        );
        return {
          executed: true,
          action: "write_executed",
          upstreamResult: {
            platform: result.platform,
            txnType: result.txnType,
            txnId: result.txnId,
            previousAccountRef: result.previousAccountRef,
            newAccountRef: result.newAccountRef,
          },
          message: `Transaction category updated on platform ${result.platform} for ${result.txnType} ${result.txnId}`,
        };
      } catch (err) {
        if (err instanceof TransactionNotFoundError) {
          logger.warn(
            {
              approvalId: approval.id,
              companyId: approval.companyId,
              approvalType: type,
              txnId: payload.txnId,
              attemptedPlatform: err.platform,
              attemptedTypes: err.attemptedTypes,
            },
            "Transaction category approval execution failed — transaction still not found on replay",
          );
          return {
            executed: false,
            action: "write_failed_replay",
            message: `Transaction ${payload.txnId} still not found on replay. Approval cannot be executed automatically; manual intervention required (the transaction may be a type not yet supported by the dispatcher).`,
          };
        }
        if (err instanceof TransactionTypeNotCategorizableError) {
          logger.warn(
            {
              approvalId: approval.id,
              companyId: approval.companyId,
              approvalType: type,
              txnId: payload.txnId,
              resolvedPlatform: err.platform,
              resolvedTxnType: err.txnType,
            },
            "Transaction category approval execution failed — resolved type not categorizable",
          );
          return {
            executed: false,
            action: "write_failed_replay",
            message: `Transaction ${payload.txnId} resolved to type ${err.platform}.${err.txnType}, which does not support category updates. Manual intervention required.`,
          };
        }
        // Any other error (network failure, auth issue, platform 5xx, etc.)
        // propagates as-is. The approval flow's outer error handler will
        // log it. We don't swallow unknown errors silently.
        throw err;
      }
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
