import { and, eq } from "drizzle-orm";
import { clientCharterStatus } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

// Charter status service — source of truth for whether a client receives
// Charter pricing per EA Section 7.1 and Q1 of the Phase 4c.5 WIP doc.
//
// Public API:
//   - getCharterStatus(db, companyId, ghlContactId) — returns current
//     status, defaulting to "never_charter" if no row exists. Callers can
//     rely on this never throwing for missing rows (the default IS the
//     business rule for unknown clients).
//   - isCharterForInvoicing(db, companyId, ghlContactId) — returns true
//     only when status === "active". This is the function the Invoice
//     endpoint will call to populate the isCharter parameter of
//     getExpectedPriceCents.
//
// Mutation helpers (called from onboarding / cancellation workflows):
//   - grantCharterToNewClient(db, companyId, ghlContactId, reason?) —
//     inserts a row with status="active". Throws CharterAlreadyExistsError
//     if a row already exists.
//   - recordNonCharterClient(db, companyId, ghlContactId, reason?) —
//     inserts a row with status="never_charter". Throws if row exists.
//   - cancelCharter(db, companyId, ghlContactId, reason?) — transitions
//     active → cancelled_was_charter. Throws CharterTransitionError if
//     the current status is anything other than "active".
//
// State-transition invariants enforced at this layer (NOT DB-level):
//   - "cancelled_was_charter" → "active": FORBIDDEN (rule 3 from EA 7.1)
//   - "never_charter" → "active": FORBIDDEN (rule 1, no retroactive grants)
//   - All other transitions either explicit (cancelCharter) or via fresh
//     row insertion (no UPDATE path exists to mutate status arbitrarily).

export type CharterStatus = "active" | "cancelled_was_charter" | "never_charter";

export class CharterAlreadyExistsError extends Error {
  constructor(public readonly companyId: string, public readonly ghlContactId: string) {
    super(`Charter status row already exists for company=${companyId} contact=${ghlContactId}`);
    this.name = "CharterAlreadyExistsError";
  }
}

export class CharterTransitionError extends Error {
  constructor(
    public readonly companyId: string,
    public readonly ghlContactId: string,
    public readonly currentStatus: CharterStatus,
    public readonly attemptedTransition: string,
  ) {
    super(
      `Cannot ${attemptedTransition} for company=${companyId} contact=${ghlContactId}: ` +
        `current status is "${currentStatus}"`,
    );
    this.name = "CharterTransitionError";
  }
}

export class CharterNotFoundError extends Error {
  constructor(public readonly companyId: string, public readonly ghlContactId: string) {
    super(`No charter status row found for company=${companyId} contact=${ghlContactId}`);
    this.name = "CharterNotFoundError";
  }
}

// Read the current charter status for a client. Defaults to "never_charter"
// when no row exists — the business default for a previously-unseen client.
// This means isCharterForInvoicing returns false for any client without an
// explicit "active" row, which is the safe default for billing.
export async function getCharterStatus(
  db: Db,
  companyId: string,
  ghlContactId: string,
): Promise<CharterStatus> {
  const rows = await db
    .select({ status: clientCharterStatus.status })
    .from(clientCharterStatus)
    .where(
      and(
        eq(clientCharterStatus.companyId, companyId),
        eq(clientCharterStatus.ghlContactId, ghlContactId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    return "never_charter";
  }
  return rows[0].status as CharterStatus;
}

// Convenience predicate for Invoice endpoint. Returns true iff status is
// "active" — i.e., the client is currently a Charter member and should
// be billed at Charter rates.
export async function isCharterForInvoicing(
  db: Db,
  companyId: string,
  ghlContactId: string,
): Promise<boolean> {
  const status = await getCharterStatus(db, companyId, ghlContactId);
  return status === "active";
}

// Insert a new charter row for a client whose tier-assignment workflow has
// determined they qualify for Charter (i.e., they are among the first 10
// paying clients). Idempotent in the sense that re-attempting creation
// throws a typed error rather than silently overwriting.
export async function grantCharterToNewClient(
  db: Db,
  companyId: string,
  ghlContactId: string,
  reason?: string,
): Promise<void> {
  // Check for existing row first to surface a typed error
  const existing = await db
    .select({ id: clientCharterStatus.id })
    .from(clientCharterStatus)
    .where(
      and(
        eq(clientCharterStatus.companyId, companyId),
        eq(clientCharterStatus.ghlContactId, ghlContactId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new CharterAlreadyExistsError(companyId, ghlContactId);
  }

  const now = new Date();
  await db.insert(clientCharterStatus).values({
    companyId,
    ghlContactId,
    grantedAt: now,
    status: "active",
    statusChangedAt: now,
    cancelledAt: null,
    reason: reason ?? null,
  });
}

// Insert a new charter row for a client who does NOT qualify for Charter
// (signed up after the first 10, OR a returning ex-Charter client). Same
// idempotency as grantCharterToNewClient — typed error on re-attempt.
export async function recordNonCharterClient(
  db: Db,
  companyId: string,
  ghlContactId: string,
  reason?: string,
): Promise<void> {
  const existing = await db
    .select({ id: clientCharterStatus.id })
    .from(clientCharterStatus)
    .where(
      and(
        eq(clientCharterStatus.companyId, companyId),
        eq(clientCharterStatus.ghlContactId, ghlContactId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new CharterAlreadyExistsError(companyId, ghlContactId);
  }

  const now = new Date();
  await db.insert(clientCharterStatus).values({
    companyId,
    ghlContactId,
    grantedAt: null,
    status: "never_charter",
    statusChangedAt: now,
    cancelledAt: null,
    reason: reason ?? null,
  });
}

// Transition an existing Charter client from "active" to
// "cancelled_was_charter". Throws CharterTransitionError if the current
// status is not "active" — this protects against accidentally calling
// cancelCharter on a never_charter client (would not affect billing but
// pollutes the audit trail) or re-cancelling an already-cancelled row.
//
// Throws CharterNotFoundError if no row exists — cancellation requires
// a pre-existing row to transition from.
export async function cancelCharter(
  db: Db,
  companyId: string,
  ghlContactId: string,
  reason?: string,
): Promise<void> {
  const rows = await db
    .select({ id: clientCharterStatus.id, status: clientCharterStatus.status })
    .from(clientCharterStatus)
    .where(
      and(
        eq(clientCharterStatus.companyId, companyId),
        eq(clientCharterStatus.ghlContactId, ghlContactId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new CharterNotFoundError(companyId, ghlContactId);
  }

  const currentStatus = rows[0].status as CharterStatus;
  if (currentStatus !== "active") {
    throw new CharterTransitionError(
      companyId,
      ghlContactId,
      currentStatus,
      "cancel charter",
    );
  }

  const now = new Date();
  await db
    .update(clientCharterStatus)
    .set({
      status: "cancelled_was_charter",
      statusChangedAt: now,
      cancelledAt: now,
      reason: reason ?? null,
      updatedAt: now,
    })
    .where(eq(clientCharterStatus.id, rows[0].id));
}
