import { and, eq, isNull } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

// Version-aware seed helper for safety-layer canonical data per Phase 4c.5
// Decision 3 (Option D-modified, locked 2026-05-24).
//
// Use case: admin endpoints (POST /api/admin/pricing/seed, etc.) call this
// to safely insert canonical reference data without overwriting existing rows
// or losing audit history.
//
// Behavior per candidate row:
//   - Identity tuple already exists with effective_to IS NULL AND values match
//     -> SKIP (no DB write). Counted as `skipped`.
//   - Identity tuple already exists with effective_to IS NULL AND values differ
//     -> SUPERSEDE: set existing row's effective_to = NOW(), INSERT new row.
//        Counted as `superseded` + `newRows`.
//   - No active row with this identity exists
//     -> INSERT new row. Counted as `inserted`.
//
// This is "version-aware idempotency": safe to re-run with identical data
// (skips silently); supports change-and-re-seed (supersedes with proper
// effective-dating); preserves all historical versions as queryable rows.
//
// Each calling schema must define:
//   - identityFields: array of column names that determine uniqueness
//     (e.g., for service_tier_pricing: ["tier", "isCharter"])
//   - valueFields: array of column names that determine "identical"
//     (e.g., for service_tier_pricing: ["monthlyAmountCents", "currency"])
//   - The schema must include effective_to: timestamp (nullable; NULL = active)
//     and effective_from: timestamp (defaults to NOW() on insert)

export interface CompareAndSeedResult {
  inserted: number;
  skipped: number;
  superseded: number;
  newRows: number;
}

export interface CompareAndSeedOptions<TSchema extends PgTable, TRow> {
  // The Drizzle table schema (e.g., serviceTierPricing)
  table: TSchema;
  // Field names on the schema that determine row identity (e.g., ['tier', 'isCharter'])
  identityFields: ReadonlyArray<keyof TRow & string>;
  // Field names on the schema that determine "identical values" (e.g., ['monthlyAmountCents', 'currency'])
  valueFields: ReadonlyArray<keyof TRow & string>;
  // Field name for the "effective_to" timestamp column (most schemas use 'effectiveTo')
  effectiveToField: keyof TRow & string;
  // Candidate rows to seed
  candidateRows: ReadonlyArray<Partial<TRow>>;
  // Human-readable label for logging
  schemaLabel: string;
}

export async function compareAndSeed<TSchema extends PgTable, TRow>(
  db: Db,
  opts: CompareAndSeedOptions<TSchema, TRow>,
): Promise<CompareAndSeedResult> {
  const result: CompareAndSeedResult = {
    inserted: 0,
    skipped: 0,
    superseded: 0,
    newRows: 0,
  };

  const now = new Date();

  for (const candidate of opts.candidateRows) {
    // Build the WHERE conditions: each identity field matches AND effectiveTo IS NULL
    const conditions = opts.identityFields.map((fieldName) => {
      const value = (candidate as Record<string, unknown>)[fieldName];
      const column = (opts.table as unknown as Record<string, unknown>)[fieldName];
      if (column === undefined) {
        throw new Error(
          `compareAndSeed: identity field '${fieldName}' not found on schema for ${opts.schemaLabel}`,
        );
      }
      return eq(column as never, value as never);
    });

    const effectiveToColumn = (opts.table as unknown as Record<string, unknown>)[opts.effectiveToField];
    if (effectiveToColumn === undefined) {
      throw new Error(
        `compareAndSeed: effectiveTo field '${opts.effectiveToField}' not found on schema for ${opts.schemaLabel}`,
      );
    }
    conditions.push(isNull(effectiveToColumn as never));

    // Find the active row with matching identity
    const activeRows = await db
      .select()
      .from(opts.table as never)
      .where(and(...conditions))
      .limit(1);

    if (activeRows.length === 0) {
      // No active row exists -> INSERT
      await db.insert(opts.table as never).values(candidate as never);
      result.inserted++;
      continue;
    }

    // Active row exists. Compare value fields.
    const activeRow = activeRows[0] as Record<string, unknown>;
    const candidateAsRecord = candidate as Record<string, unknown>;

    const valuesMatch = opts.valueFields.every((fieldName) => {
      return activeRow[fieldName] === candidateAsRecord[fieldName];
    });

    if (valuesMatch) {
      // Identical -> SKIP
      result.skipped++;
      continue;
    }

    // Values differ -> SUPERSEDE: expire the old row and insert the new
    // (note: this is two separate DB operations; if either fails, the helper's
    // outer transaction is responsible for rollback. Callers should wrap in
    // db.transaction() if atomicity across all rows is required.)
    const idField = (opts.table as unknown as Record<string, unknown>)["id"];
    if (idField === undefined) {
      throw new Error(
        `compareAndSeed: id field not found on schema for ${opts.schemaLabel} (required for supersede)`,
      );
    }
    const activeId = activeRow["id"];

    await db
      .update(opts.table as never)
      .set({ [opts.effectiveToField]: now } as never)
      .where(eq(idField as never, activeId as never));

    await db.insert(opts.table as never).values(candidate as never);

    result.superseded++;
    result.newRows++;
  }

  logger.info(
    {
      schemaLabel: opts.schemaLabel,
      candidateCount: opts.candidateRows.length,
      ...result,
    },
    "compareAndSeed completed",
  );

  return result;
}
