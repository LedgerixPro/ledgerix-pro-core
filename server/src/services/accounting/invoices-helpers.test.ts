import { describe, expect, it } from "vitest";
import {
  confidenceForMatchType,
  evaluateInvoicePricing,
} from "./invoices-helpers.js";

// Decision 7 Piece H tests. Both helpers are pure (no db, no I/O), so
// these tests have no mocks — just direct call + assert. Parallels the
// shape of payments-helpers.test.ts's logic-only sections.

describe("evaluateInvoicePricing", () => {
  it("returns matches=true with zero delta when sent equals expected", () => {
    const result = evaluateInvoicePricing(59900, 59900);
    expect(result.matches).toBe(true);
    expect(result.deltaCents).toBe(0);
    expect(result.deltaPercent).toBe(0);
  });

  it("returns matches=false with positive delta when sent is over expected (overbilled)", () => {
    // sent 60000, expected 59900 → delta 100, ~0.167%
    const result = evaluateInvoicePricing(60000, 59900);
    expect(result.matches).toBe(false);
    expect(result.deltaCents).toBe(100);
    expect(result.deltaPercent).toBeCloseTo(0.17, 2);
  });

  it("returns matches=false with negative delta when sent is under expected (underbilled)", () => {
    // sent 59900, expected 60000 → delta -100, ~-0.167%
    const result = evaluateInvoicePricing(59900, 60000);
    expect(result.matches).toBe(false);
    expect(result.deltaCents).toBe(-100);
    expect(result.deltaPercent).toBeCloseTo(-0.17, 2);
  });

  it("returns matches=false for a one-cent discrepancy (zero-tolerance, the load-bearing test for Q-inv-3-α)", () => {
    // The whole point of Q-inv-3-α: ANY non-zero delta escalates. A $0.01
    // discrepancy on our own invoice is worth a human glance per the
    // Trust Tenet conservative path.
    const overByOneCent = evaluateInvoicePricing(59901, 59900);
    expect(overByOneCent.matches).toBe(false);
    expect(overByOneCent.deltaCents).toBe(1);

    const underByOneCent = evaluateInvoicePricing(59899, 59900);
    expect(underByOneCent.matches).toBe(false);
    expect(underByOneCent.deltaCents).toBe(-1);
  });

  describe("expected===0 divide-by-zero guard", () => {
    it("returns deltaPercent=0 when both sent and expected are 0 (exact match at zero)", () => {
      const result = evaluateInvoicePricing(0, 0);
      expect(result.matches).toBe(true);
      expect(result.deltaCents).toBe(0);
      expect(result.deltaPercent).toBe(0);
      expect(Number.isFinite(result.deltaPercent)).toBe(true);
    });

    it("returns deltaPercent=100 when sent>0 but expected=0 (no NaN/Infinity)", () => {
      const result = evaluateInvoicePricing(5000, 0);
      expect(result.matches).toBe(false);
      expect(result.deltaCents).toBe(5000);
      expect(result.deltaPercent).toBe(100);
      expect(Number.isFinite(result.deltaPercent)).toBe(true);
      expect(Number.isNaN(result.deltaPercent)).toBe(false);
    });
  });
});

describe("confidenceForMatchType", () => {
  it("returns 0.5 for 'email_only_different_name' (Q-inv-2-α — email match with name conflict)", () => {
    expect(confidenceForMatchType("email_only_different_name")).toBe(0.5);
  });

  it("returns 0.3 for 'name_only' (Q-inv-2-α — name match without email confirmation)", () => {
    expect(confidenceForMatchType("name_only")).toBe(0.3);
  });
});
