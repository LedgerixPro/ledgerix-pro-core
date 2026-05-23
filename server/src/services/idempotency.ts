import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { idempotencyKeys } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Idempotency support for write endpoints per PHASE-4-ACCOUNTING-API-SPEC
// Section 2B.1.
//
// Behavior:
// - Same (companyId, key) + same request hash within window: return stored
//   response with replayed = true. Caller sets meta.idempotencyReplay = true.
// - Same (companyId, key) + different request hash within window: throw
//   IdempotencyConflictError. Caller returns 409 with code "idempotency_conflict".
// - No existing row: run the work, store the result, return with replayed = false.
//
// Window default is 24 hours, configurable via ttlHours.
//
// Concurrent insert race: the unique constraint on (company_id, key) ensures
// only one insert wins. The loser retries the SELECT and returns the winner's
// stored result as a replay. This handles the case where two simultaneous
// requests with the same key both try to insert; the database serializes them.

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency key reused with different request body");
    this.name = "IdempotencyConflictError";
  }
}

export interface WithIdempotencyOptions {
  companyId: string;
  // Idempotency-Key header value. If null, the work runs without storage —
  // caller must still call this for code uniformity, but no row is written.
  key: string | null;
  // Request body. Hashed via SHA-256 of canonicalized JSON for comparison.
  requestBody: unknown;
  // TTL window in hours. Defaults to 24 per spec.
  ttlHours?: number;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

// Canonicalize a value into a stable JSON string for hashing. Sorts object
// keys recursively so {a:1, b:2} and {b:2, a:1} produce identical hashes.
// Arrays preserve order (intentional — array order is semantically significant).
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k]));
  return "{" + parts.join(",") + "}";
}

// SHA-256 hex of canonicalized request body. Same input → same hash.
export function hashRequestBody(body: unknown): string {
  return createHash("sha256").update(canonicalize(body)).digest("hex");
}

// Core helper. Wraps `work` with idempotency check + storage.
export async function withIdempotency<T>(
  db: Db,
  options: WithIdempotencyOptions,
  work: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  // No key → no storage, just run the work
  if (!options.key) {
    const result = await work();
    return { ...result, replayed: false };
  }

  const requestHash = hashRequestBody(options.requestBody);
  const ttlHours = options.ttlHours ?? 24;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  // Look up existing row
  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.companyId, options.companyId),
        eq(idempotencyKeys.key, options.key),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    // Check window
    if (row.expiresAt > now) {
      if (row.requestHash === requestHash) {
        // Replay
        logger.info(
          { companyId: options.companyId, key: options.key },
          "idempotency.replay",
        );
        return {
          status: row.responseStatus,
          body: row.responseBody as T,
          replayed: true,
        };
      }
      // Conflict: same key, different body
      logger.warn(
        { companyId: options.companyId, key: options.key },
        "idempotency.conflict",
      );
      throw new IdempotencyConflictError();
    }
    // Expired row — fall through to run work. The insert below will fail on
    // the unique constraint; we delete the expired row first.
    await db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.companyId, options.companyId),
          eq(idempotencyKeys.key, options.key),
        ),
      );
  }

  // Run the work
  const result = await work();

  // Store the result. If a concurrent request inserted first, this will fail
  // on the unique constraint — we re-read and return the winner's value as
  // a replay (best-effort consistency).
  try {
    await db.insert(idempotencyKeys).values({
      companyId: options.companyId,
      key: options.key,
      requestHash,
      responseBody: result.body as Record<string, unknown>,
      responseStatus: result.status,
      expiresAt,
    });
  } catch (err) {
    // Likely unique constraint violation from concurrent insert
    const concurrent = await db
      .select()
      .from(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.companyId, options.companyId),
          eq(idempotencyKeys.key, options.key),
        ),
      )
      .limit(1);
    if (concurrent.length > 0) {
      logger.info(
        { companyId: options.companyId, key: options.key },
        "idempotency.concurrent_replay",
      );
      return {
        status: concurrent[0].responseStatus,
        body: concurrent[0].responseBody as T,
        replayed: true,
      };
    }
    // Some other error — re-throw
    throw err;
  }

  return { ...result, replayed: false };
}
