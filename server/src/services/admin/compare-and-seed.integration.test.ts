import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  serviceTierPricing,
  writeThresholds,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { compareAndSeed } from "./compare-and-seed.js";

// Integration tests for compareAndSeed against a real embedded Postgres.
//
// These exist because the unit tests in compare-and-seed.test.ts use a no-op
// db.where() mock that doesn't model SQL semantics. The null-identity bug
// discovered in production on 2026-05-25 passed all unit tests but failed
// when run against real SQL — `eq(column, NULL)` is never true in SQL (not
// even NULL = NULL), so re-running a seed with null identity fields created
// duplicate rows instead of skipping.
//
// Tests here exercise the helper against real Drizzle + real Postgres, so
// edge cases like null-equality semantics surface immediately.
//
// Lifecycle pattern follows server/src/__tests__/costs-service.test.ts:
//   getEmbeddedPostgresTestSupport() probes whether embedded-postgres works
//   on this platform; tests are skipped via describe.skip on platforms
//   where the binary can't run.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("compareAndSeed integration — null identity fields", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-compare-and-seed-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Clean both tables between tests so each starts fresh.
    await db.delete(writeThresholds);
    await db.delete(serviceTierPricing);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // -------------------------------------------------------------------------
  // The bug repro: thresholds seed with null ghlContactId
  // -------------------------------------------------------------------------

  it("skips re-run of thresholds seed when identity tuple contains null (REGRESSION: null-identity bug 2026-05-25)", async () => {
    // This is the scenario that failed in production on 2026-05-25.
    // Canonical write_thresholds rows have ghl_contact_id = NULL (global thresholds).
    // First seed: inserts the row.
    // Second seed with IDENTICAL data: should skip, but with the bug, inserted again.

    const candidate = {
      ghlContactId: null,
      endpoint: "accounting.payments",
      field: "amount",
      comparator: "gt",
      thresholdValue: 1000000,
      action: "require_approval",
      reason: "Payment threshold per EA Section 6.3 — CFO must sign off",
    };

    // First seed — fresh table, expect insert.
    const firstResult = await compareAndSeed(db, {
      table: writeThresholds,
      identityFields: ["endpoint", "field", "ghlContactId"],
      valueFields: ["comparator", "thresholdValue", "action", "reason"],
      effectiveToField: "effectiveTo",
      candidateRows: [candidate],
      schemaLabel: "write_thresholds",
    });

    expect(firstResult).toEqual({
      inserted: 1,
      skipped: 0,
      superseded: 0,
      newRows: 0,
    });

    // Verify exactly 1 row exists.
    const rowsAfterFirst = await db.select().from(writeThresholds);
    expect(rowsAfterFirst).toHaveLength(1);

    // Second seed — IDENTICAL data, expect skip (NOT insert).
    // This is the assertion that fails with the unfixed helper because
    // eq(ghl_contact_id, NULL) never matches in SQL.
    const secondResult = await compareAndSeed(db, {
      table: writeThresholds,
      identityFields: ["endpoint", "field", "ghlContactId"],
      valueFields: ["comparator", "thresholdValue", "action", "reason"],
      effectiveToField: "effectiveTo",
      candidateRows: [candidate],
      schemaLabel: "write_thresholds",
    });

    expect(secondResult).toEqual({
      inserted: 0,
      skipped: 1,
      superseded: 0,
      newRows: 0,
    });

    // Critical assertion: still exactly 1 row after re-run, NOT 2.
    const rowsAfterSecond = await db.select().from(writeThresholds);
    expect(rowsAfterSecond).toHaveLength(1);
  });

  it("supersedes a row whose identity tuple contains null when values change", async () => {
    // Same identity (null ghlContactId), different values → supersede path.
    // Confirms the fix doesn't break the supersede flow.

    const original = {
      ghlContactId: null,
      endpoint: "accounting.invoices",
      field: "lineItems.sum",
      comparator: "gt",
      thresholdValue: 100000,
      action: "require_approval",
      reason: "Original threshold",
    };

    await compareAndSeed(db, {
      table: writeThresholds,
      identityFields: ["endpoint", "field", "ghlContactId"],
      valueFields: ["comparator", "thresholdValue", "action", "reason"],
      effectiveToField: "effectiveTo",
      candidateRows: [original],
      schemaLabel: "write_thresholds",
    });

    // Change the threshold value; same identity tuple.
    const updated = { ...original, thresholdValue: 200000, reason: "Updated threshold" };

    const supersedeResult = await compareAndSeed(db, {
      table: writeThresholds,
      identityFields: ["endpoint", "field", "ghlContactId"],
      valueFields: ["comparator", "thresholdValue", "action", "reason"],
      effectiveToField: "effectiveTo",
      candidateRows: [updated],
      schemaLabel: "write_thresholds",
    });

    expect(supersedeResult).toEqual({
      inserted: 0,
      skipped: 0,
      superseded: 1,
      newRows: 1,
    });

    // After supersede: 2 rows total (1 expired, 1 active).
    const allRows = await db.select().from(writeThresholds);
    expect(allRows).toHaveLength(2);

    // Exactly 1 row is currently active (effective_to IS NULL).
    const activeRows = allRows.filter((r) => r.effectiveTo === null);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].thresholdValue).toBe(200000);
    expect(activeRows[0].reason).toBe("Updated threshold");

    // The expired row has effective_to set.
    const expiredRows = allRows.filter((r) => r.effectiveTo !== null);
    expect(expiredRows).toHaveLength(1);
    expect(expiredRows[0].thresholdValue).toBe(100000);
  });

  // -------------------------------------------------------------------------
  // Regression smoke test: pricing path (no nullable identity fields) still works
  // -------------------------------------------------------------------------

  it("pricing seed with non-null identity tuple skips correctly on re-run (smoke test for no-regression)", async () => {
    // Pricing identity is [tier, isCharter] — no nullable fields, so this
    // worked correctly even with the original bug. Exists to prove the fix
    // doesn't regress the no-nulls case.

    const candidate = {
      tier: "Foundation",
      isCharter: true,
      monthlyAmountCents: 19900,
      currency: "USD",
    };

    const firstResult = await compareAndSeed(db, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [candidate],
      schemaLabel: "service_tier_pricing",
    });

    expect(firstResult.inserted).toBe(1);

    const secondResult = await compareAndSeed(db, {
      table: serviceTierPricing,
      identityFields: ["tier", "isCharter"],
      valueFields: ["monthlyAmountCents", "currency"],
      effectiveToField: "effectiveTo",
      candidateRows: [candidate],
      schemaLabel: "service_tier_pricing",
    });

    expect(secondResult.skipped).toBe(1);
    expect(secondResult.inserted).toBe(0);

    // Confirm only 1 row.
    const rows = await db.select().from(serviceTierPricing);
    expect(rows).toHaveLength(1);
  });
});
