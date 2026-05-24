import { and, eq, isNull, or } from "drizzle-orm";
import { writeThresholds } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

// Threshold service for Phase 4c safety architecture per ADR-003 Q8.
//
// Looks up active write thresholds for a given endpoint, considering both
// per-client overrides (most specific) and global defaults (fallback).
// Returns all matching active threshold rows so callers can apply them
// independently — a single endpoint might have multiple thresholds covering
// different fields (e.g., amount AND lineItems.count).
//
// Caller is responsible for evaluating each threshold against the request:
//   - Comparing actual field value against thresholdValue using comparator
//   - Calling getNestedField() or equivalent to extract the value
//   - Acting per the action field (currently only "require_approval" supported)

export type ThresholdAction = "require_approval";
export type ThresholdComparator = "gt" | "gte";

export interface WriteThreshold {
  id: string;
  ghlContactId: string | null;
  endpoint: string;
  field: string;
  comparator: ThresholdComparator;
  thresholdValue: number;
  action: ThresholdAction;
  reason: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}

// Get all active thresholds applicable to a (endpoint, contactId) tuple.
//
// Returns thresholds in priority order: per-client thresholds first (more
// specific), then global thresholds (less specific). For the same endpoint+
// field combination, callers should use the FIRST matching threshold —
// per-client overrides global.
//
// Honest implementation note: deduplication of overlapping endpoint+field
// across per-client and global is NOT done by the service function. Callers
// can implement that logic if they need it (most callers will iterate all
// thresholds and apply each one, which is the safer pattern).
//
// Returns empty array if no thresholds exist — no thresholds means no
// approval required (writes proceed normally).
export async function getApplicableThresholds(
  db: Db,
  endpoint: string,
  contactId?: string | null,
): Promise<WriteThreshold[]> {
  // Query: matching endpoint AND (per-client matches OR is global) AND active
  const conditions = [
    eq(writeThresholds.endpoint, endpoint),
    isNull(writeThresholds.effectiveTo),
  ];

  // Add contact-scoping condition
  if (contactId) {
    // Match this specific contact OR global (NULL)
    conditions.push(
      or(
        eq(writeThresholds.ghlContactId, contactId),
        isNull(writeThresholds.ghlContactId),
      )!,
    );
  } else {
    // No contactId — only global thresholds apply
    conditions.push(isNull(writeThresholds.ghlContactId));
  }

  const rows = await db
    .select()
    .from(writeThresholds)
    .where(and(...conditions));

  // Sort: per-client (non-null contactId) before global (null contactId)
  // so callers iterating get the more-specific thresholds first.
  return rows.sort((a, b) => {
    if (a.ghlContactId !== null && b.ghlContactId === null) return -1;
    if (a.ghlContactId === null && b.ghlContactId !== null) return 1;
    return 0;
  }) as WriteThreshold[];
}

// Get the most-specific applicable threshold for a single (endpoint, field, contactId).
// Per-client threshold wins over global if both exist for the same endpoint+field.
//
// Returns null if no threshold applies.
//
// Used by callers that only care about ONE threshold per field, e.g., the
// payments endpoint checking amount.
export async function getMostSpecificThreshold(
  db: Db,
  endpoint: string,
  field: string,
  contactId?: string | null,
): Promise<WriteThreshold | null> {
  const thresholds = await getApplicableThresholds(db, endpoint, contactId);
  // Already sorted per-client first. Filter to the requested field.
  const matching = thresholds.filter((t) => t.field === field);
  return matching.length > 0 ? matching[0] : null;
}

// Evaluate whether a value exceeds a threshold per its comparator.
// Returns true if the threshold is exceeded (i.e., approval is required).
export function isThresholdExceeded(threshold: WriteThreshold, value: number): boolean {
  if (threshold.comparator === "gt") return value > threshold.thresholdValue;
  if (threshold.comparator === "gte") return value >= threshold.thresholdValue;
  throw new Error(`Unknown comparator: ${threshold.comparator}`);
}
