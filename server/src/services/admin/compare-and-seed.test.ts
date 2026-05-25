import { describe, it, expect, vi, beforeEach } from "vitest";
import { compareAndSeed } from "./compare-and-seed.js";
import { serviceTierPricing } from "@paperclipai/db";

// Mock the DB with a fluent Drizzle-style interface, similar to pricing.test.ts.
//
// compareAndSeed exercises three chains per candidate row:
//   READ:      db.select().from(table).where(...).limit(1)        -> active row(s)
//   INSERT:    db.insert(table).values(candidate)                  -> void
//   UPDATE:    db.update(table).set({effectiveTo: now}).where(...) -> void  (supersede path only)
//
// The helper iterates opts.candidateRows in order; each iteration runs READ once
// and conditionally INSERT and/or UPDATE. Tests pre-seed the read results in
// the same order as the candidate rows.

interface MockDbHandle {
  db: unknown;
  insertCalls: Array<{ table: unknown; values: unknown }>;
  updateCalls: Array<{ table: unknown; set: unknown }>;
  readCallCount: () => number;
}

/**
 * Build a mock DB where each candidate row's read returns the corresponding
 * entry in `readResults` (an array of arrays — one outer entry per candidate).
 *
 * Example: readResults = [[], [{existingRow}], []] means candidate #0 finds no
 * active row, candidate #1 finds one, candidate #2 finds none.
 */
function createMockDb(opts: {
  readResults: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>;
}): MockDbHandle {
  let readIdx = 0;
  const insertCalls: MockDbHandle["insertCalls"] = [];
  const updateCalls: MockDbHandle["updateCalls"] = [];

  // Insert chain: db.insert(table).values(candidate). Returns thenable so
  // `await db.insert(...).values(...)` resolves cleanly.
  const insertChain = (table: unknown) => ({
    values: vi.fn(async (values: unknown) => {
      insertCalls.push({ table, values });
      return undefined;
    }),
  });

  // Update chain: db.update(table).set({...}).where(...). The await is on the
  // `.where(...)` call (terminus of the chain).
  const updateChain = (table: unknown) => {
    let setValue: unknown;
    return {
      set: vi.fn((s: unknown) => {
        setValue = s;
        return {
          where: vi.fn(async () => {
            updateCalls.push({ table, set: setValue });
            return undefined;
          }),
        };
      }),
    };
  };

  // Select chain: db.select().from(table).where(...).limit(N) -> Promise<row[]>.
  // .limit() is the async terminus.
  const selectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(async () => {
      const result = opts.readResults[readIdx] ?? [];
      readIdx++;
      return result;
    });
    return chain;
  };

  const db = {
    select: vi.fn(() => selectChain()),
    insert: vi.fn((table: unknown) => insertChain(table)),
    update: vi.fn((table: unknown) => updateChain(table)),
  };

  return {
    db,
    insertCalls,
    updateCalls,
    readCallCount: () => readIdx,
  };
}

// Realistic candidate rows for the happy-path tests. Matches what admin.ts
// would actually pass for serviceTierPricing.
const FOUNDATION_CHARTER = {
  tier: "Foundation",
  isCharter: true,
  monthlyAmountCents: 19900,
  currency: "USD",
};
const FOUNDATION_STANDARD = {
  tier: "Foundation",
  isCharter: false,
  monthlyAmountCents: 29900,
  currency: "USD",
};
const GROWTH_CHARTER = {
  tier: "Growth Engine",
  isCharter: true,
  monthlyAmountCents: 39900,
  currency: "USD",
};

describe("compareAndSeed — insert path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts every candidate when no active rows exist", async () => {
    const { db, insertCalls, updateCalls, readCallCount } = createMockDb({
      readResults: [[], []],
    });

    const result = await compareAndSeed(db as never, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [FOUNDATION_CHARTER, FOUNDATION_STANDARD],
      schemaLabel: "service_tier_pricing",
    });

    expect(result).toEqual({
      inserted: 2,
      skipped: 0,
      superseded: 0,
      newRows: 0,
    });
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0].values).toEqual(FOUNDATION_CHARTER);
    expect(insertCalls[1].values).toEqual(FOUNDATION_STANDARD);
    expect(updateCalls).toHaveLength(0);
    expect(readCallCount()).toBe(2);
  });
});

describe("compareAndSeed — skip path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips candidates whose active rows have identical values", async () => {
    const existingFoundationCharter = {
      id: "uuid-1",
      tier: "Foundation",
      isCharter: true,
      monthlyAmountCents: 19900,
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveTo: null,
      createdAt: new Date(),
    };
    const existingFoundationStandard = {
      id: "uuid-2",
      tier: "Foundation",
      isCharter: false,
      monthlyAmountCents: 29900,
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveTo: null,
      createdAt: new Date(),
    };

    const { db, insertCalls, updateCalls } = createMockDb({
      readResults: [[existingFoundationCharter], [existingFoundationStandard]],
    });

    const result = await compareAndSeed(db as never, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [FOUNDATION_CHARTER, FOUNDATION_STANDARD],
      schemaLabel: "service_tier_pricing",
    });

    expect(result).toEqual({
      inserted: 0,
      skipped: 2,
      superseded: 0,
      newRows: 0,
    });
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("compareAndSeed — supersede path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supersedes candidates whose active rows have differing values", async () => {
    // Existing row has DIFFERENT monthlyAmountCents than the candidate.
    // Same identity tuple (tier, isCharter), so the helper should supersede.
    const existingCharterWithOldPrice = {
      id: "uuid-existing-1",
      tier: "Foundation",
      isCharter: true,
      monthlyAmountCents: 14900, // OLD price; candidate has 19900
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveTo: null,
      createdAt: new Date(),
    };

    const { db, insertCalls, updateCalls } = createMockDb({
      readResults: [[existingCharterWithOldPrice]],
    });

    const result = await compareAndSeed(db as never, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [FOUNDATION_CHARTER],
      schemaLabel: "service_tier_pricing",
    });

    expect(result).toEqual({
      inserted: 0,
      skipped: 0,
      superseded: 1,
      newRows: 1,
    });
    expect(updateCalls).toHaveLength(1);
    // Update should have set effectiveTo on the old row.
    expect(updateCalls[0].set).toHaveProperty("effectiveTo");
    expect((updateCalls[0].set as { effectiveTo: Date }).effectiveTo).toBeInstanceOf(Date);
    // And inserted a new row with the new values.
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toEqual(FOUNDATION_CHARTER);
  });
});

describe("compareAndSeed — mixed path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("handles insert + skip + supersede in a single batch", async () => {
    // Three candidates:
    //   #0 FOUNDATION_CHARTER  -> no active row -> INSERT
    //   #1 FOUNDATION_STANDARD -> identical active row -> SKIP
    //   #2 GROWTH_CHARTER      -> active row with different values -> SUPERSEDE
    const existingFoundationStandard = {
      id: "uuid-existing-fs",
      tier: "Foundation",
      isCharter: false,
      monthlyAmountCents: 29900,
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveTo: null,
      createdAt: new Date(),
    };
    const existingGrowthCharterOldPrice = {
      id: "uuid-existing-gc",
      tier: "Growth Engine",
      isCharter: true,
      monthlyAmountCents: 34900, // OLD price; candidate has 39900
      currency: "USD",
      effectiveFrom: new Date(),
      effectiveTo: null,
      createdAt: new Date(),
    };

    const { db, insertCalls, updateCalls } = createMockDb({
      readResults: [
        [], // #0 no active row
        [existingFoundationStandard], // #1 identical
        [existingGrowthCharterOldPrice], // #2 different
      ],
    });

    const result = await compareAndSeed(db as never, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [FOUNDATION_CHARTER, FOUNDATION_STANDARD, GROWTH_CHARTER],
      schemaLabel: "service_tier_pricing",
    });

    expect(result).toEqual({
      inserted: 1,
      skipped: 1,
      superseded: 1,
      newRows: 1,
    });
    // Two inserts total: one for the brand-new row, one for the superseded
    // row's replacement.
    expect(insertCalls).toHaveLength(2);
    // One update — for the supersede.
    expect(updateCalls).toHaveLength(1);
  });
});

describe("compareAndSeed — error paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when identityFields references a column not on the schema", async () => {
    const { db } = createMockDb({ readResults: [[]] });

    await expect(
      compareAndSeed(db as never, {
        table: serviceTierPricing,
        // @ts-expect-error — intentionally passing an invalid field name to test runtime guard
        identityFields: ["tier", "nonexistentColumn"],
        valueFields: ["monthlyAmountCents", "currency"],
        effectiveToField: "effectiveTo",
        candidateRows: [FOUNDATION_CHARTER],
        schemaLabel: "service_tier_pricing",
      }),
    ).rejects.toThrow(/identity field 'nonexistentColumn' not found.*service_tier_pricing/);
  });

  it("throws when effectiveToField references a column not on the schema", async () => {
    const { db } = createMockDb({ readResults: [[]] });

    await expect(
      compareAndSeed(db as never, {
        table: serviceTierPricing,
        identityFields: ["tier", "isCharter"],
        valueFields: ["monthlyAmountCents", "currency"],
        // @ts-expect-error — intentionally passing an invalid field name
        effectiveToField: "nonexistentTimestamp",
        candidateRows: [FOUNDATION_CHARTER],
        schemaLabel: "service_tier_pricing",
      }),
    ).rejects.toThrow(/effectiveTo field 'nonexistentTimestamp' not found.*service_tier_pricing/);
  });

  it("throws on supersede when the schema lacks an id column", async () => {
    // Construct a fake table object that's missing the 'id' column but has
    // every other column the helper accesses. This isolates the id-missing
    // branch from the identity-missing branch tested above.
    const fakeTableMissingId = {
      tier: { columnName: "tier" },
      isCharter: { columnName: "is_charter" },
      monthlyAmountCents: { columnName: "monthly_amount_cents" },
      currency: { columnName: "currency" },
      effectiveTo: { columnName: "effective_to" },
      // NOTE: no `id` field
    };

    // Read returns a differing row, forcing the supersede branch.
    const { db } = createMockDb({
      readResults: [
        [
          {
            id: "uuid-x",
            tier: "Foundation",
            isCharter: true,
            monthlyAmountCents: 99999, // different from candidate
            currency: "USD",
            effectiveTo: null,
          },
        ],
      ],
    });

    await expect(
      compareAndSeed(db as never, {
        // @ts-expect-error — fake table doesn't satisfy PgTable, intentional for runtime guard test
        table: fakeTableMissingId,
        identityFields: ["tier", "isCharter"],
        valueFields: ["monthlyAmountCents", "currency"],
        effectiveToField: "effectiveTo",
        candidateRows: [FOUNDATION_CHARTER],
        schemaLabel: "fake_no_id",
      }),
    ).rejects.toThrow(/id field not found.*fake_no_id/);
  });
});
