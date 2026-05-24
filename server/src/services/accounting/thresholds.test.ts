import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getApplicableThresholds,
  getMostSpecificThreshold,
  isThresholdExceeded,
  type WriteThreshold,
} from "./thresholds.js";
import { writeThresholds } from "@paperclipai/db";

interface ThresholdRow {
  id: string;
  ghlContactId: string | null;
  endpoint: string;
  field: string;
  comparator: "gt" | "gte";
  thresholdValue: number;
  action: "require_approval";
  reason: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

function createMockDb(opts: { thresholdResults?: ThresholdRow[] } = {}) {
  let currentTable: "thresholds" | null = null;
  const db: Record<string, unknown> = {};

  db.select = vi.fn(() => {
    currentTable = null;
    return db;
  });

  db.from = vi.fn((table: unknown) => {
    if (table === writeThresholds) currentTable = "thresholds";
    return db;
  });

  db.where = vi.fn(async () => {
    if (currentTable === "thresholds") return opts.thresholdResults ?? [];
    return [];
  });

  return { db };
}

function makeThreshold(overrides: Partial<ThresholdRow>): ThresholdRow {
  const now = new Date();
  return {
    id: "default-id",
    ghlContactId: null,
    endpoint: "accounting.payments",
    field: "amount",
    comparator: "gt",
    thresholdValue: 1000000,
    action: "require_approval",
    reason: "Test threshold",
    effectiveFrom: now,
    effectiveTo: null,
    createdAt: now,
    ...overrides,
  };
}

describe("getApplicableThresholds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns thresholds in priority order (per-client first, then global)", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "global-1", ghlContactId: null, thresholdValue: 1000000 }),
        makeThreshold({ id: "client-1", ghlContactId: "contact-1", thresholdValue: 500000 }),
      ],
    });

    const result = await getApplicableThresholds(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "contact-1",
    );

    expect(result).toHaveLength(2);
    // Per-client first
    expect(result[0].ghlContactId).toBe("contact-1");
    expect(result[0].thresholdValue).toBe(500000);
    // Then global
    expect(result[1].ghlContactId).toBeNull();
    expect(result[1].thresholdValue).toBe(1000000);
  });

  it("returns empty array when no thresholds exist", async () => {
    const { db } = createMockDb({ thresholdResults: [] });

    const result = await getApplicableThresholds(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "contact-1",
    );

    expect(result).toEqual([]);
  });

  it("returns only global thresholds when contactId is not provided", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "global-1", ghlContactId: null }),
      ],
    });

    const result = await getApplicableThresholds(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
    );

    expect(result).toHaveLength(1);
    expect(result[0].ghlContactId).toBeNull();
  });

  it("returns only global thresholds when contactId is null", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "global-1", ghlContactId: null }),
      ],
    });

    const result = await getApplicableThresholds(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      null,
    );

    expect(result).toHaveLength(1);
    expect(result[0].ghlContactId).toBeNull();
  });

  it("preserves all matching rows when multiple per-client thresholds exist for different fields", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "client-amount", ghlContactId: "contact-1", field: "amount" }),
        makeThreshold({ id: "client-count", ghlContactId: "contact-1", field: "lineItems.count", thresholdValue: 20 }),
      ],
    });

    const result = await getApplicableThresholds(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "contact-1",
    );

    expect(result).toHaveLength(2);
    expect(result.map((t) => t.field).sort()).toEqual(["amount", "lineItems.count"]);
  });
});

describe("getMostSpecificThreshold", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns per-client threshold when both per-client and global exist for the same field", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "client-1", ghlContactId: "contact-1", thresholdValue: 500000 }),
        makeThreshold({ id: "global-1", ghlContactId: null, thresholdValue: 1000000 }),
      ],
    });

    const result = await getMostSpecificThreshold(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "amount",
      "contact-1",
    );

    expect(result?.id).toBe("client-1");
    expect(result?.thresholdValue).toBe(500000);
  });

  it("falls back to global threshold when no per-client threshold exists for the field", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "global-1", ghlContactId: null }),
      ],
    });

    const result = await getMostSpecificThreshold(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "amount",
      "contact-1",
    );

    expect(result?.id).toBe("global-1");
  });

  it("returns null when no threshold matches the field", async () => {
    const { db } = createMockDb({
      thresholdResults: [
        makeThreshold({ id: "global-1", ghlContactId: null, field: "amount" }),
      ],
    });

    const result = await getMostSpecificThreshold(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "lineItems.count",
      "contact-1",
    );

    expect(result).toBeNull();
  });

  it("returns null when no thresholds exist at all", async () => {
    const { db } = createMockDb({ thresholdResults: [] });

    const result = await getMostSpecificThreshold(
      // @ts-expect-error mock db
      db,
      "accounting.payments",
      "amount",
      "contact-1",
    );

    expect(result).toBeNull();
  });
});

describe("isThresholdExceeded", () => {
  it("returns true when value > threshold with gt comparator", () => {
    const t = makeThreshold({ comparator: "gt", thresholdValue: 1000000 });
    expect(isThresholdExceeded(t as WriteThreshold, 1000001)).toBe(true);
    expect(isThresholdExceeded(t as WriteThreshold, 1500000)).toBe(true);
  });

  it("returns false when value <= threshold with gt comparator", () => {
    const t = makeThreshold({ comparator: "gt", thresholdValue: 1000000 });
    expect(isThresholdExceeded(t as WriteThreshold, 1000000)).toBe(false);
    expect(isThresholdExceeded(t as WriteThreshold, 999999)).toBe(false);
  });

  it("returns true when value >= threshold with gte comparator", () => {
    const t = makeThreshold({ comparator: "gte", thresholdValue: 1000000 });
    expect(isThresholdExceeded(t as WriteThreshold, 1000000)).toBe(true);
    expect(isThresholdExceeded(t as WriteThreshold, 1500000)).toBe(true);
  });

  it("returns false when value < threshold with gte comparator", () => {
    const t = makeThreshold({ comparator: "gte", thresholdValue: 1000000 });
    expect(isThresholdExceeded(t as WriteThreshold, 999999)).toBe(false);
  });

  it("throws on unknown comparator", () => {
    const t = makeThreshold({ comparator: "lt" as never });
    expect(() => isThresholdExceeded(t as WriteThreshold, 1000)).toThrow(/Unknown comparator/);
  });
});
