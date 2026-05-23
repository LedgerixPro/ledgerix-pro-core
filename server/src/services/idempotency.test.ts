import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  withIdempotency,
  hashRequestBody,
  IdempotencyConflictError,
} from "./idempotency.js";

// Mock drizzle's Db with a chainable fluent interface that captures calls.
// Each test sets up specific return values for select.limit() and insert.
// The mock returns `this` for chain methods so the call chain is preserved.
interface MockRow {
  id: string;
  companyId: string;
  key: string;
  requestHash: string;
  responseBody: Record<string, unknown>;
  responseStatus: number;
  createdAt: Date;
  expiresAt: Date;
}

function createMockDb(opts: {
  existingRows?: MockRow[];
  insertThrows?: Error;
  postInsertRows?: MockRow[]; // rows returned by select() after insert fails
} = {}) {
  const insertCalls: Array<Record<string, unknown>> = [];
  const deleteCalls: number[] = [];
  let selectCallCount = 0;

  const db = {
    select: vi.fn(() => db),
    from: vi.fn(() => db),
    where: vi.fn(() => db),
    limit: vi.fn(async () => {
      selectCallCount++;
      // First select is the lookup. If insert throws, the second select
      // returns postInsertRows. Otherwise return existingRows.
      if (selectCallCount === 1) return opts.existingRows ?? [];
      return opts.postInsertRows ?? [];
    }),
    insert: vi.fn(() => ({
      values: vi.fn(async (vals: Record<string, unknown>) => {
        insertCalls.push(vals);
        if (opts.insertThrows) throw opts.insertThrows;
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => {
        deleteCalls.push(1);
      }),
    })),
  };
  return { db, insertCalls, deleteCalls, getSelectCallCount: () => selectCallCount };
}

describe("hashRequestBody", () => {
  it("returns same hash for same input", () => {
    const a = hashRequestBody({ foo: "bar", baz: 42 });
    const b = hashRequestBody({ foo: "bar", baz: 42 });
    expect(a).toBe(b);
  });

  it("returns same hash regardless of object key order", () => {
    const a = hashRequestBody({ foo: "bar", baz: 42 });
    const b = hashRequestBody({ baz: 42, foo: "bar" });
    expect(a).toBe(b);
  });

  it("returns different hashes for different content", () => {
    const a = hashRequestBody({ foo: "bar" });
    const b = hashRequestBody({ foo: "baz" });
    expect(a).not.toBe(b);
  });

  it("preserves array order in hash (arrays are semantically ordered)", () => {
    const a = hashRequestBody([1, 2, 3]);
    const b = hashRequestBody([3, 2, 1]);
    expect(a).not.toBe(b);
  });

  it("returns a 64-character hex string", () => {
    const h = hashRequestBody({ anything: "here" });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("handles null and primitive values", () => {
    expect(hashRequestBody(null)).toBeDefined();
    expect(hashRequestBody("string")).toBeDefined();
    expect(hashRequestBody(42)).toBeDefined();
  });
});

describe("withIdempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs work without storage when key is null", async () => {
    const { db, insertCalls } = createMockDb();
    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    const result = await withIdempotency(
      // @ts-expect-error mock db doesn't fully implement Db
      db,
      { companyId: "c1", key: null, requestBody: { x: 1 } },
      work,
    );

    expect(work).toHaveBeenCalledOnce();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.replayed).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it("runs work and stores result when key is new", async () => {
    const { db, insertCalls } = createMockDb({ existingRows: [] });
    const work = vi.fn(async () => ({ status: 201, body: { id: "new-1" } }));

    const result = await withIdempotency(
      // @ts-expect-error mock db
      db,
      { companyId: "c1", key: "key-abc", requestBody: { foo: "bar" } },
      work,
    );

    expect(work).toHaveBeenCalledOnce();
    expect(result.status).toBe(201);
    expect(result.body).toEqual({ id: "new-1" });
    expect(result.replayed).toBe(false);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      companyId: "c1",
      key: "key-abc",
      responseStatus: 201,
    });
    expect(insertCalls[0].requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns stored result with replayed=true when key matches and hash matches", async () => {
    const requestBody = { foo: "bar" };
    const hash = hashRequestBody(requestBody);
    const future = new Date(Date.now() + 60_000);
    const { db, insertCalls } = createMockDb({
      existingRows: [
        {
          id: "row-1",
          companyId: "c1",
          key: "key-abc",
          requestHash: hash,
          responseBody: { id: "stored-1" },
          responseStatus: 200,
          createdAt: new Date(),
          expiresAt: future,
        },
      ],
    });
    const work = vi.fn(async () => ({ status: 201, body: { id: "new-1" } }));

    const result = await withIdempotency(
      // @ts-expect-error mock db
      db,
      { companyId: "c1", key: "key-abc", requestBody },
      work,
    );

    expect(work).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ id: "stored-1" });
    expect(result.replayed).toBe(true);
    expect(insertCalls).toHaveLength(0);
  });

  it("throws IdempotencyConflictError when key matches but hash differs", async () => {
    const future = new Date(Date.now() + 60_000);
    const { db } = createMockDb({
      existingRows: [
        {
          id: "row-1",
          companyId: "c1",
          key: "key-abc",
          requestHash: "different-hash-not-matching",
          responseBody: { id: "stored-1" },
          responseStatus: 200,
          createdAt: new Date(),
          expiresAt: future,
        },
      ],
    });
    const work = vi.fn();

    await expect(
      withIdempotency(
        // @ts-expect-error mock db
        db,
        { companyId: "c1", key: "key-abc", requestBody: { different: "body" } },
        work,
      ),
    ).rejects.toThrow(IdempotencyConflictError);

    expect(work).not.toHaveBeenCalled();
  });

  it("deletes expired row and runs work fresh", async () => {
    const requestBody = { foo: "bar" };
    const past = new Date(Date.now() - 60_000);
    const { db, insertCalls, deleteCalls } = createMockDb({
      existingRows: [
        {
          id: "row-1",
          companyId: "c1",
          key: "key-abc",
          requestHash: hashRequestBody(requestBody),
          responseBody: { id: "stored-old" },
          responseStatus: 200,
          createdAt: past,
          expiresAt: past, // expired
        },
      ],
    });
    const work = vi.fn(async () => ({ status: 201, body: { id: "fresh-1" } }));

    const result = await withIdempotency(
      // @ts-expect-error mock db
      db,
      { companyId: "c1", key: "key-abc", requestBody },
      work,
    );

    expect(work).toHaveBeenCalledOnce();
    expect(result.body).toEqual({ id: "fresh-1" });
    expect(result.replayed).toBe(false);
    expect(deleteCalls).toHaveLength(1); // expired row deleted
    expect(insertCalls).toHaveLength(1); // fresh result stored
  });

  it("returns concurrent-insert winner's result as replay when our insert fails", async () => {
    const requestBody = { foo: "bar" };
    const hash = hashRequestBody(requestBody);
    const future = new Date(Date.now() + 60_000);
    const { db } = createMockDb({
      existingRows: [], // initial lookup finds nothing
      insertThrows: new Error("unique constraint violation"),
      postInsertRows: [
        // After insert fails, re-select finds the winner's row
        {
          id: "winner-row",
          companyId: "c1",
          key: "key-abc",
          requestHash: hash,
          responseBody: { id: "winner-1" },
          responseStatus: 201,
          createdAt: new Date(),
          expiresAt: future,
        },
      ],
    });
    const work = vi.fn(async () => ({ status: 201, body: { id: "loser-1" } }));

    const result = await withIdempotency(
      // @ts-expect-error mock db
      db,
      { companyId: "c1", key: "key-abc", requestBody },
      work,
    );

    expect(work).toHaveBeenCalledOnce(); // we did the work
    expect(result.body).toEqual({ id: "winner-1" }); // but returned winner's result
    expect(result.replayed).toBe(true);
  });

  it("re-throws insert errors when not a concurrent-insert race", async () => {
    const { db } = createMockDb({
      existingRows: [],
      insertThrows: new Error("some other DB error"),
      postInsertRows: [], // no row exists after our failed insert
    });
    const work = vi.fn(async () => ({ status: 201, body: { id: "new-1" } }));

    await expect(
      withIdempotency(
        // @ts-expect-error mock db
        db,
        { companyId: "c1", key: "key-abc", requestBody: { x: 1 } },
        work,
      ),
    ).rejects.toThrow("some other DB error");
  });

  it("respects custom ttlHours when computing expiresAt", async () => {
    const { db, insertCalls } = createMockDb({ existingRows: [] });
    const work = vi.fn(async () => ({ status: 200, body: { ok: true } }));

    const before = Date.now();
    await withIdempotency(
      // @ts-expect-error mock db
      db,
      { companyId: "c1", key: "key-abc", requestBody: {}, ttlHours: 1 },
      work,
    );

    const inserted = insertCalls[0];
    const expiresAt = inserted.expiresAt as Date;
    const diffMs = expiresAt.getTime() - before;
    // Should be ~1 hour (3,600,000 ms) — allow generous tolerance for test slop
    expect(diffMs).toBeGreaterThan(3_500_000);
    expect(diffMs).toBeLessThan(3_700_000);
  });
});
