// Decision 7 Piece H helpers (DESIGN LOCK 2026-05-28, see
// docs/wip/phase-4c-5-write-endpoints-and-admin-api.md). Two pure
// invoice-specific helpers used by BOTH the future route handler (Piece K)
// and the future approval-replay path (Piece I). Mirrors Decision 6's
// payments-helpers.ts pattern: keep the shared logic in one file so the
// route and the replay path can't drift apart on translation/validation.
//
// evaluateInvoicePricing: zero-tolerance pricing comparison per Q-inv-3-α.
// Returns whether the agent-sent amount exactly matches the expected
// price computed from the locked pricing tables, plus the delta fields
// the InvoicePricingMismatchPayload.pricingDecision sub-object needs.
//
// confidenceForMatchType: fixed heuristic mapper per Q-inv-2-α.
// findOrCreateCustomer does not compute a numeric confidence score;
// rather than invent a scorer, we map the two ambiguous matchType values
// to documented placeholder values. The InvoiceDedupeAmbiguousPayload's
// dedupeDecision.confidence field is populated from this mapper.
//
// Both helpers are PURE (no db, no I/O, no upstream calls). Route +
// replay wiring lands in Pieces K and I respectively.

// =============================================================================
// evaluateInvoicePricing — Q-inv-3-α zero-tolerance comparison
// =============================================================================

export interface InvoicePricingEvaluation {
  // True iff sentAmountCents === expectedAmountCents (EXACT match).
  // Any non-zero delta means matches=false — see JSDoc on evaluateInvoicePricing
  // for the zero-tolerance rationale.
  matches: boolean;
  // sentAmountCents - expectedAmountCents (signed). Positive = agent
  // overbilled vs. canonical price; negative = underbilled. Lands in
  // InvoicePricingMismatchPayload.pricingDecision.deltaCents.
  deltaCents: number;
  // (deltaCents / expectedAmountCents) * 100, rounded to 2 decimals.
  // Recorded for the approver's context but is NOT part of the gate
  // condition per Q-inv-3-α (the gate is matches=true iff deltaCents===0).
  // Guards divide-by-zero when expectedAmountCents===0.
  deltaPercent: number;
}

// Zero-tolerance per Decision 7 Q-inv-3-α: Ledgerix Pro bills its OWN
// clients a KNOWN price from its OWN pricing tables. There is no rounding
// slack, no FX ambiguity, no upstream-API jitter to absorb. The Trust
// Tenet (#14) favors the conservative path; a $1 discrepancy on our own
// invoice is worth a human glance. Any non-zero deltaCents escalates to
// the accounting.invoice.pricing_mismatch approval flow.
//
// deltaPercent edge cases:
//   - expectedAmountCents === 0 && sentAmountCents === 0 → 0% (no error,
//     exact match at zero)
//   - expectedAmountCents === 0 && sentAmountCents !== 0 → 100% (the
//     entire sent amount is over the expected zero; reported as 100 to
//     avoid NaN/Infinity and to communicate "fully unexpected charge")
//   - otherwise → (deltaCents / expectedAmountCents) * 100, rounded to 2
//     decimal places for display/audit clarity
export function evaluateInvoicePricing(
  sentAmountCents: number,
  expectedAmountCents: number,
): InvoicePricingEvaluation {
  const deltaCents = sentAmountCents - expectedAmountCents;
  const matches = deltaCents === 0;

  let deltaPercent: number;
  if (expectedAmountCents === 0) {
    deltaPercent = sentAmountCents === 0 ? 0 : 100;
  } else {
    const rawPercent = (deltaCents / expectedAmountCents) * 100;
    // Round to 2 decimal places (banker's rounding via toFixed is
    // acceptable here — this value is for display/audit, never for
    // the gate condition).
    deltaPercent = Math.round(rawPercent * 100) / 100;
  }

  return { matches, deltaCents, deltaPercent };
}

// =============================================================================
// confidenceForMatchType — Q-inv-2-α heuristic placeholder mapper
// =============================================================================

// Per Decision 7 Q-inv-2-α: findOrCreateCustomer does NOT compute a
// numeric confidence score — it returns a categorical `action`
// discriminant. Rather than invent a scorer at the route layer, we
// derive `confidence` from the matchType via a FIXED HEURISTIC mapping:
//
//   "email_only_different_name" → 0.5
//     The email matches an existing customer but the names disagree.
//     Strong "same entity, data drift" signal (people change names; an
//     email is a stable identifier). Higher confidence the records
//     refer to the same person.
//
//   "name_only" → 0.3
//     The name matches but the email is either absent or different.
//     Weaker signal (common names are common; emails are the more
//     reliable identifier). Lower confidence.
//
// These are documented placeholders. If a real scorer is later added to
// findOrCreateCustomer, the route should pass the computed score through
// instead of calling this mapper — interface-compatible extension, no
// payload change.
export function confidenceForMatchType(
  matchType: "name_only" | "email_only_different_name",
): number {
  if (matchType === "email_only_different_name") {
    return 0.5;
  }
  return 0.3;
}
