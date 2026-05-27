import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock thresholds.js partially: getMostSpecificThreshold becomes a spy so
// evaluatePaymentThreshold tests don't need a real DB. isThresholdExceeded
// stays REAL — we want to exercise the comparator integration end-to-end,
// not stub it.
vi.mock("./thresholds.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./thresholds.js")>();
  return {
    ...actual,
    getMostSpecificThreshold: vi.fn(),
  };
});

import { accountingConnections } from "@paperclipai/db";
import { getMostSpecificThreshold, type WriteThreshold } from "./thresholds.js";
import {
  EntityRefResolutionError,
  evaluatePaymentThreshold,
  resolveEntityRefByPlatform,
} from "./payments-helpers.js";

// Pure-mock pattern parallels reconcile-payment.test.ts: fluent-chain mock DB
// keyed on table identity. resolveEntityRefByPlatform performs one
// accountingConnections lookup; we control its result via the mock.

interface ConnectionRow {
  platform: string;
}

function createMockDb(connectionRows: ConnectionRow[] = []) {
  let currentTable: "connections" | null = null;
  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => {
    currentTable = null;
    return db;
  });

  db.from = vi.fn((table: unknown) => {
    if (table === accountingConnections) currentTable = "connections";
    return db;
  });

  db.where = vi.fn(() => db);

  db.limit = vi.fn(async () => {
    if (currentTable === "connections") return connectionRows;
    return [];
  });

  return db;
}

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const CONTACT_ID = "contact-test-1";

// Mock-DB sentinel for evaluatePaymentThreshold tests — the helper passes
// db straight through to the mocked getMostSpecificThreshold, so the db
// value never gets exercised.
const MOCK_DB = {} as never;

describe("resolveEntityRefByPlatform", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("QBO connection: returns { platform: 'quickbooks', ref: { customerId } }", async () => {
    const db = createMockDb([{ platform: "quickbooks" }]);

    const result = await resolveEntityRefByPlatform(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "cust-1",
    );

    expect(result).toEqual({
      platform: "quickbooks",
      ref: { customerId: "cust-1" },
    });
    expect(result.ref.accountId).toBeUndefined();
  });

  it("Xero connection: returns { platform: 'xero', ref: { accountId } }", async () => {
    const db = createMockDb([{ platform: "xero" }]);

    const result = await resolveEntityRefByPlatform(
      db as never,
      COMPANY_ID,
      CONTACT_ID,
      "acct-1",
    );

    expect(result).toEqual({
      platform: "xero",
      ref: { accountId: "acct-1" },
    });
    expect(result.ref.customerId).toBeUndefined();
  });

  it("throws EntityRefResolutionError(no_connection_found) when no row exists", async () => {
    const db = createMockDb([]);

    let caught: unknown;
    try {
      await resolveEntityRefByPlatform(db as never, COMPANY_ID, CONTACT_ID, "ref-x");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EntityRefResolutionError);
    const e = caught as EntityRefResolutionError;
    expect(e.reason).toBe("no_connection_found");
    expect(e.companyId).toBe(COMPANY_ID);
    expect(e.contactId).toBe(CONTACT_ID);
    expect(e.resolvedPlatform).toBeUndefined();
  });

  it("throws EntityRefResolutionError(unsupported_platform) when platform is not QBO/Xero (defensive)", async () => {
    const db = createMockDb([{ platform: "future_platform_v2" }]);

    let caught: unknown;
    try {
      await resolveEntityRefByPlatform(db as never, COMPANY_ID, CONTACT_ID, "ref-x");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EntityRefResolutionError);
    const e = caught as EntityRefResolutionError;
    expect(e.reason).toBe("unsupported_platform");
    expect(e.resolvedPlatform).toBe("future_platform_v2");
    expect(e.message).toContain("resolvedPlatform=future_platform_v2");
  });

  it("null contactId path: lookup query still constructs (uses isNull internally, not eq)", async () => {
    // We can't easily inspect the drizzle WHERE clause from here, but we
    // verify the function works when contactId is null. The implementation
    // branches on `contactId === null` to call isNull(...) instead of eq(...);
    // a regression that swapped these would still pass this test BUT would
    // fail against real Postgres (`eq(col, NULL)` never matches). The
    // integration safety net is the existing Defect 1 lesson.
    const db = createMockDb([{ platform: "quickbooks" }]);

    const result = await resolveEntityRefByPlatform(
      db as never,
      COMPANY_ID,
      null, // global / system-scoped connection
      "cust-2",
    );

    expect(result.platform).toBe("quickbooks");
    expect(result.ref.customerId).toBe("cust-2");
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it("EntityRefResolutionError message includes companyId + contactId", async () => {
    const db = createMockDb([]);

    let caught: unknown;
    try {
      await resolveEntityRefByPlatform(db as never, "company-A", "contact-B", "ref");
    } catch (err) {
      caught = err;
    }

    const e = caught as EntityRefResolutionError;
    expect(e.message).toContain("companyId=company-A");
    expect(e.message).toContain("contactId=contact-B");
    expect(e.name).toBe("EntityRefResolutionError");
  });
});

// =============================================================================

function fakeThreshold(overrides: Partial<WriteThreshold> = {}): WriteThreshold {
  return {
    id: "thresh-test-1",
    ghlContactId: null,
    endpoint: "accounting.payments",
    field: "amount",
    comparator: "gt",
    thresholdValue: 1_000_000, // $10,000 in cents per WRITE_THRESHOLDS_SEED
    action: "require_approval",
    reason: "Payment amount exceeds $10,000 threshold per EA Section 6.3 — CFO must sign off",
    effectiveFrom: new Date(),
    effectiveTo: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("evaluatePaymentThreshold", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns { exceeded: false } when no threshold is seeded for the endpoint", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(null);

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 5_000_000);

    expect(result).toEqual({ exceeded: false });
    expect(result.thresholdAmount).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("returns { exceeded: false } when threshold exists but amount does NOT exceed (gt comparator)", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({ comparator: "gt", thresholdValue: 1_000_000 }),
    );

    // amount = 500_000 (i.e., $5,000) is NOT > $10,000
    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 500_000);

    expect(result).toEqual({ exceeded: false });
  });

  it("returns { exceeded: false } when amount equals threshold under 'gt' comparator (boundary)", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({ comparator: "gt", thresholdValue: 1_000_000 }),
    );

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 1_000_000);

    expect(result.exceeded).toBe(false); // gt: amount === threshold is NOT exceeded
  });

  it("returns { exceeded: true } when amount equals threshold under 'gte' comparator (boundary contrast)", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({ comparator: "gte", thresholdValue: 1_000_000 }),
    );

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 1_000_000);

    expect(result.exceeded).toBe(true); // gte: amount === threshold IS exceeded
    expect(result.thresholdAmount).toBe(1_000_000);
  });

  it("returns { exceeded: true, thresholdAmount, reason } when amount exceeds threshold (gt)", async () => {
    const threshold = fakeThreshold({
      comparator: "gt",
      thresholdValue: 1_000_000,
      reason: "Payment amount exceeds $10,000 threshold per EA Section 6.3 — CFO must sign off",
    });
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(threshold);

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 1_500_000);

    expect(result).toEqual({
      exceeded: true,
      thresholdAmount: 1_000_000,
      reason: "Payment amount exceeds $10,000 threshold per EA Section 6.3 — CFO must sign off",
    });
  });

  it("per-client override scenario: threshold returned by getMostSpecificThreshold uses the per-client value", async () => {
    // Simulate getMostSpecificThreshold's per-client-takes-precedence behavior
    // by mocking it to return a contact-specific threshold with a different value
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({
        ghlContactId: CONTACT_ID,
        comparator: "gt",
        thresholdValue: 50_000, // override: $500 (much lower than $10K global)
        reason: "Per-client override: small business, requires extra scrutiny",
      }),
    );

    // Amount $1,000 is under the global $10K but OVER the per-client $500
    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 100_000);

    expect(result.exceeded).toBe(true);
    expect(result.thresholdAmount).toBe(50_000);
    expect(result.reason).toContain("Per-client override");
  });

  it("threshold reason field propagates to result.reason when exceeded", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({ reason: "Custom audit-trail reason text" }),
    );

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 2_000_000);

    expect(result.reason).toBe("Custom audit-trail reason text");
  });

  it("threshold with null-cast reason surfaces as undefined (defensive ?? fallback)", async () => {
    // The WriteThreshold type declares reason as `string` (non-null), but
    // the helper uses `threshold.reason ?? undefined` as a defensive guard.
    // Verify the guard works if the DB ever surfaces a null (e.g., legacy
    // row predating the not-null constraint).
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(
      fakeThreshold({ reason: null as unknown as string }),
    );

    const result = await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 2_000_000);

    expect(result.exceeded).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("calls getMostSpecificThreshold with the exact 'accounting.payments' + 'amount' identifiers", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(null);

    await evaluatePaymentThreshold(MOCK_DB, CONTACT_ID, 5_000_000);

    expect(getMostSpecificThreshold).toHaveBeenCalledTimes(1);
    expect(getMostSpecificThreshold).toHaveBeenCalledWith(
      MOCK_DB,
      "accounting.payments",
      "amount",
      CONTACT_ID,
    );
  });

  it("passes null contactId through to getMostSpecificThreshold unchanged (global-threshold lookup)", async () => {
    vi.mocked(getMostSpecificThreshold).mockResolvedValueOnce(null);

    await evaluatePaymentThreshold(MOCK_DB, null, 5_000_000);

    expect(getMostSpecificThreshold).toHaveBeenCalledWith(
      MOCK_DB,
      "accounting.payments",
      "amount",
      null,
    );
  });
});
