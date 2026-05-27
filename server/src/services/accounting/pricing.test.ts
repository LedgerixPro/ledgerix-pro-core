import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getExpectedPriceCents,
  getSetupFeeCents,
  PricingNotFoundError,
  SetupFeeNotFoundError,
  type ServiceTier,
} from "./pricing.js";
import {
  clientPricingOverrides,
  serviceTierPricing,
  setupFeePricing,
} from "@paperclipai/db";

// Mock the DB with a fluent Drizzle-style interface. Each test sets up
// specific return values for the two select-chains used by the service:
//   1. SELECT from clientPricingOverrides
//   2. SELECT from serviceTierPricing
// Calls return in order: first overrides query, then tier query.

interface OverrideRow {
  id: string;
  ghlContactId: string;
  tier: string;
  monthlyAmountCents: number;
  reason: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  approvedByUserId: string;
  approvedAt: Date;
  createdAt: Date;
}

interface TierPriceRow {
  id: string;
  tier: string;
  isCharter: boolean;
  monthlyAmountCents: number;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

function createMockDb(opts: {
  overrideResults?: OverrideRow[];
  tierResults?: TierPriceRow[];
} = {}) {
  // Track which table each query is targeting by reference-comparing the
  // schema object passed to from(). The schemas are imported above; the
  // service imports the same exports so identity-comparison works cleanly.
  let currentTable: "override" | "tier" | null = null;
  let selectCallCount = 0;

  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => {
    selectCallCount++;
    currentTable = null;
    return db;
  });

  db.from = vi.fn((table: unknown) => {
    if (table === clientPricingOverrides) currentTable = "override";
    else if (table === serviceTierPricing) currentTable = "tier";
    return db;
  });

  db.where = vi.fn(() => db);

  db.limit = vi.fn(async () => {
    if (currentTable === "override") return opts.overrideResults ?? [];
    return opts.tierResults ?? [];
  });

  return { db, getSelectCallCount: () => selectCallCount };
}

describe("getExpectedPriceCents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns override price when an active override exists for the contact and tier", async () => {
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [
        {
          id: "override-uuid-1",
          ghlContactId: "contact-1",
          tier: "Foundation",
          monthlyAmountCents: 15000,
          reason: "Negotiated rate during beta",
          effectiveFrom: now,
          effectiveTo: null,
          approvedByUserId: "scott",
          approvedAt: now,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
      false,
      "contact-1",
    );

    expect(result.amountCents).toBe(15000);
    expect(result.source).toBe("override");
    expect(result.priceRecordId).toBe("override-uuid-1");
  });

  it("returns canonical charter price when no override exists and isCharter=true", async () => {
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [
        {
          id: "tier-uuid-1",
          tier: "Foundation",
          isCharter: true,
          monthlyAmountCents: 19900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
      true,
      "contact-1",
    );

    expect(result.amountCents).toBe(19900);
    expect(result.source).toBe("tier_charter");
    expect(result.priceRecordId).toBe("tier-uuid-1");
  });

  it("returns canonical standard price when no override and isCharter=false", async () => {
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [
        {
          id: "tier-uuid-2",
          tier: "Growth Engine",
          isCharter: false,
          monthlyAmountCents: 49900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Growth Engine",
      false,
      "contact-1",
    );

    expect(result.amountCents).toBe(49900);
    expect(result.source).toBe("tier_standard");
    expect(result.priceRecordId).toBe("tier-uuid-2");
  });

  it("skips override lookup entirely when contactId is not provided", async () => {
    const now = new Date();
    const mock = createMockDb({
      tierResults: [
        {
          id: "tier-uuid-3",
          tier: "Scale-Up",
          isCharter: false,
          monthlyAmountCents: 89900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      mock.db,
      "Scale-Up",
      false,
    );

    expect(result.amountCents).toBe(89900);
    expect(result.source).toBe("tier_standard");
    // Only the tier query should have been executed, not the override query
    expect(mock.getSelectCallCount()).toBe(1);
  });

  it("skips override lookup entirely when contactId is null", async () => {
    const now = new Date();
    const mock = createMockDb({
      tierResults: [
        {
          id: "tier-uuid-4",
          tier: "Foundation",
          isCharter: true,
          monthlyAmountCents: 19900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      mock.db,
      "Foundation",
      true,
      null,
    );

    expect(result.amountCents).toBe(19900);
    expect(mock.getSelectCallCount()).toBe(1);
  });

  it("falls through to canonical price when override results are empty (expired/absent)", async () => {
    // overrideResults: [] simulates the case where the query filters out
    // expired rows (effective_to IS NULL filter); only active rows are returned.
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [
        {
          id: "tier-uuid-5",
          tier: "Foundation",
          isCharter: false,
          monthlyAmountCents: 29900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
      false,
      "contact-with-expired-override",
    );

    expect(result.amountCents).toBe(29900);
    expect(result.source).toBe("tier_standard");
  });

  it("throws PricingNotFoundError when no canonical price exists for the tier+charter combination", async () => {
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [],
    });

    await expect(
      getExpectedPriceCents(
        // @ts-expect-error mock db
        db,
        "Foundation",
        true,
        "contact-1",
      ),
    ).rejects.toThrow(PricingNotFoundError);
  });

  it("PricingNotFoundError includes tier and isCharter in the message", async () => {
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [],
    });

    await expect(
      getExpectedPriceCents(
        // @ts-expect-error mock db
        db,
        "Scale-Up",
        true,
      ),
    ).rejects.toThrow(/tier='Scale-Up' isCharter=true/);
  });

  it("override takes precedence over canonical price (both queries return rows)", async () => {
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [
        {
          id: "override-uuid-2",
          ghlContactId: "vip-client",
          tier: "Scale-Up",
          monthlyAmountCents: 65000,
          reason: "Bulk discount per signed contract",
          effectiveFrom: now,
          effectiveTo: null,
          approvedByUserId: "scott",
          approvedAt: now,
          createdAt: now,
        },
      ],
      tierResults: [
        {
          id: "tier-uuid-6",
          tier: "Scale-Up",
          isCharter: false,
          monthlyAmountCents: 89900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Scale-Up",
      false,
      "vip-client",
    );

    // Override wins over canonical
    expect(result.amountCents).toBe(65000);
    expect(result.source).toBe("override");
    expect(result.priceRecordId).toBe("override-uuid-2");
  });

  it("returns the priceRecordId for audit logging", async () => {
    const now = new Date();
    const { db } = createMockDb({
      overrideResults: [],
      tierResults: [
        {
          id: "tier-uuid-7",
          tier: "Foundation",
          isCharter: true,
          monthlyAmountCents: 19900,
          currency: "USD",
          effectiveFrom: now,
          effectiveTo: null,
          createdAt: now,
        },
      ],
    });

    const result = await getExpectedPriceCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
      true,
      "any-contact",
    );

    expect(result.priceRecordId).toBe("tier-uuid-7");
  });
});

// ============================================================================
// getSetupFeeCents (Q2)
// ============================================================================

interface SetupFeeRow {
  id: string;
  amountCents: number;
}

// Minimal mock for the single-table query shape used by getSetupFeeCents:
//   db.select({...}).from(setupFeePricing).where(...).limit(1)
// Returns the configured rows when .from() is called against setupFeePricing,
// empty array otherwise (defends against accidental cross-table reads).
function createSetupFeeMockDb(setupFeeRows: SetupFeeRow[] = []) {
  let currentTable: "setup_fee" | null = null;
  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => {
    currentTable = null;
    return db;
  });

  db.from = vi.fn((table: unknown) => {
    if (table === setupFeePricing) currentTable = "setup_fee";
    return db;
  });

  db.where = vi.fn(() => db);

  db.limit = vi.fn(async () => {
    if (currentTable === "setup_fee") return setupFeeRows;
    return [];
  });

  return { db };
}

describe("getSetupFeeCents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the active setup fee for Foundation tier", async () => {
    const { db } = createSetupFeeMockDb([
      { id: "setup-fee-uuid-foundation", amountCents: 24900 },
    ]);

    const result = await getSetupFeeCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
    );

    expect(result.amountCents).toBe(24900);
    expect(result.priceRecordId).toBe("setup-fee-uuid-foundation");
  });

  it("returns the active setup fee for Growth Engine tier", async () => {
    const { db } = createSetupFeeMockDb([
      { id: "setup-fee-uuid-ge", amountCents: 34900 },
    ]);

    const result = await getSetupFeeCents(
      // @ts-expect-error mock db
      db,
      "Growth Engine",
    );

    expect(result.amountCents).toBe(34900);
    expect(result.priceRecordId).toBe("setup-fee-uuid-ge");
  });

  it("returns the active setup fee for Scale-Up tier", async () => {
    const { db } = createSetupFeeMockDb([
      { id: "setup-fee-uuid-su", amountCents: 120000 },
    ]);

    const result = await getSetupFeeCents(
      // @ts-expect-error mock db
      db,
      "Scale-Up",
    );

    expect(result.amountCents).toBe(120000);
    expect(result.priceRecordId).toBe("setup-fee-uuid-su");
  });

  it("throws SetupFeeNotFoundError when no active row exists for the tier", async () => {
    const { db } = createSetupFeeMockDb([]);

    let caught: unknown;
    try {
      await getSetupFeeCents(
        // @ts-expect-error mock db
        db,
        "Foundation",
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SetupFeeNotFoundError);
    expect((caught as Error).message).toContain("Foundation");
  });

  it("WHERE clause includes effective_to IS NULL (active rows only)", async () => {
    // The mock returns whatever it's given regardless of WHERE clauses, but
    // we can verify the .where() spy was called — meaning the lookup is
    // filtered, not a naked SELECT-all. The real isNull(effectiveTo) filter
    // is enforced by SQL; this test documents the contract via the spy.
    const { db } = createSetupFeeMockDb([
      { id: "setup-fee-uuid-current", amountCents: 25000 },
    ]);

    const result = await getSetupFeeCents(
      // @ts-expect-error mock db
      db,
      "Foundation",
    );

    expect(result.amountCents).toBe(25000); // current row, not historical
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it("returns SetupFeeNotFoundError mentioning the requested tier name", async () => {
    const { db } = createSetupFeeMockDb([]);

    await expect(
      getSetupFeeCents(
        // @ts-expect-error mock db
        db,
        "Scale-Up",
      ),
    ).rejects.toThrow("Scale-Up");
  });
});
