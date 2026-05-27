import { and, eq, isNull } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getMostSpecificThreshold,
  isThresholdExceeded,
} from "./thresholds.js";

// Decision 6 Piece F helpers (LOCKED 2026-05-27, see
// docs/wip/phase-4c-5-write-endpoints-and-admin-api.md). Two payment-
// specific helpers used by BOTH the future route handler (Piece G) and
// the future approval-replay path (Piece E). Keeping them in one file
// guarantees identical translation logic at both call sites — a key
// property of the Q-pay-2 split-signature decision.
//
// resolveEntityRefByPlatform: translates between the payload's
// overloaded entityRef string (single field, CustomerId for QBO or
// AccountID for Xero) and the service's split ref shape
// ({customerId?, accountId?}). Used by callers that have a payload-
// or-equivalent entityRef and need to call reconcilePayment with the
// service's typed split shape.
//
// evaluatePaymentThreshold: determines whether a given payment amount
// exceeds the applicable Phase 4c.2 write threshold. Returns a typed
// result shape that the caller uses to populate the
// PaymentThresholdExceededPayload's thresholdAmount field. Per
// sub-decision Q-pay-F-ii (2026-05-27), expectedRange is OUT OF SCOPE
// for v1 — the optional payload field stays in the locked contract but
// is not populated by this helper.

// =============================================================================
// resolveEntityRefByPlatform — Q-pay-2 translation seam
// =============================================================================

// Distinguishable from unknown errors so the route handler can surface a
// specific 400 with detail about WHICH ref-translation step failed.
export class EntityRefResolutionError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly contactId: string | null,
    public readonly reason:
      | "no_connection_found"
      | "unsupported_platform",
    public readonly resolvedPlatform?: string,
  ) {
    super(
      `Entity ref resolution failed (reason=${reason}): ` +
        `companyId=${companyId} contactId=${contactId}` +
        (resolvedPlatform ? ` resolvedPlatform=${resolvedPlatform}` : ""),
    );
    this.name = "EntityRefResolutionError";
  }
}

export interface ResolvedEntityRef {
  platform: "quickbooks" | "xero";
  ref: { customerId?: string; accountId?: string };
}

// Resolve the platform via the accountingConnections lookup, then map the
// overloaded entityRef into the service's split shape based on the platform.
//
// Caller-supplied entityRef MUST be a non-empty string. If the caller has
// a missing entityRef, that's a route-layer validation concern (a 400
// before reaching this helper).
//
// Throws EntityRefResolutionError if no connection exists for the
// (companyId, contactId) tuple, or if the resolved platform is neither
// QBO nor Xero (defensive — schema only stores those two but the type
// system can't enforce that).
export async function resolveEntityRefByPlatform(
  db: Db,
  companyId: string,
  contactId: string | null,
  entityRef: string,
): Promise<ResolvedEntityRef> {
  const rows = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        contactId === null
          ? isNull(accountingConnections.contactId)
          : eq(accountingConnections.contactId, contactId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new EntityRefResolutionError(companyId, contactId, "no_connection_found");
  }

  const platform = rows[0].platform;
  if (platform !== "quickbooks" && platform !== "xero") {
    throw new EntityRefResolutionError(
      companyId,
      contactId,
      "unsupported_platform",
      platform,
    );
  }

  // Q-pay-2 translation: same string lands in customerId (QBO) or
  // accountId (Xero) based on the resolved platform.
  if (platform === "quickbooks") {
    return { platform, ref: { customerId: entityRef } };
  }

  return { platform: "xero", ref: { accountId: entityRef } };
}

// =============================================================================
// evaluatePaymentThreshold — Q-pay-F-ii integration with Phase 4c.2 thresholds
// =============================================================================

export interface PaymentThresholdEvaluation {
  // True if amount > applicable threshold (approval required).
  // False if no threshold applies OR amount is at-or-below the threshold.
  exceeded: boolean;
  // Populated only when exceeded === true. The threshold value (in cents)
  // that the payment amount exceeded. Lands in
  // PaymentThresholdExceededPayload.thresholdAmount.
  thresholdAmount?: number;
  // Populated only when exceeded === true. The threshold's reason field
  // — useful for the 202 response's data.reason narrative.
  reason?: string;
}

// Evaluate whether a payment amount triggers approval per the Phase 4c.2
// threshold framework. Uses the "accounting.payments" endpoint with field
// "amount" — same identifiers seeded by POST /api/admin/pricing/seed (see
// WRITE_THRESHOLDS_SEED at routes/admin.ts).
//
// Returns { exceeded: false } when:
//   - No threshold seeded for (endpoint=accounting.payments, field=amount, contactId)
//   - A threshold exists but amount does NOT exceed it per the threshold's comparator
//
// Returns { exceeded: true, thresholdAmount, reason } when:
//   - The most-specific threshold for the (contactId or global) exists AND
//     amount exceeds it per the threshold's comparator.
//
// Per-client overrides take precedence over global per the threshold
// service's getMostSpecificThreshold contract.
export async function evaluatePaymentThreshold(
  db: Db,
  contactId: string | null,
  amount: number,
): Promise<PaymentThresholdEvaluation> {
  const threshold = await getMostSpecificThreshold(
    db,
    "accounting.payments",
    "amount",
    contactId,
  );

  if (threshold === null) {
    return { exceeded: false };
  }

  if (!isThresholdExceeded(threshold, amount)) {
    return { exceeded: false };
  }

  return {
    exceeded: true,
    thresholdAmount: threshold.thresholdValue,
    reason: threshold.reason ?? undefined,
  };
}
