# WIP: Phase 4c.5 — Re-ship Write Endpoints Atop Safety Layer + Admin API Foundation

**Status:** in_progress
**Started:** 2026-05-24
**Last updated:** 2026-05-27 Session 4 (Decision 4 Phase 2 — QBO half complete + Xero shared-endpoint revision documented)
**Owner:** Scott Hansbury
**Related ADRs:**
- ADR-001 (Pattern B Full API endpoints)
- ADR-002 (Phase 4b write endpoint design — idempotency, audit log, two-phase failure)
- ADR-003 (Phase 4c safety architecture + 3 amendments)
**Estimated remaining work:** Multi-session. Original estimate 20-30 hours; ~5-6 hours shipped across Sessions 1-2:
- ~~Admin endpoint scaffolding (auth, routing, base pattern): 2-3 hours~~ — DONE Session 2 (commit `ff3875e8`)
- ~~Bootstrap data via admin endpoints (pricing, thresholds): 1-2 hours~~ — DONE Session 2 end-of-day (pricing seeded clean, thresholds seeded then re-run exposed a null-identity bug — see Defects Discovered)
- ~~Fix compareAndSeed null-identity bug + harden tests: 2-3 hours~~ — DONE Session 3 (commit `1727746a`, verified in prod via re-run, audit_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`)
- Charter status storage decision + implementation: 3-5 hours
- Setup fee handling decision + implementation: 3-5 hours
- Implement Decision 4 (get-transaction-by-id infrastructure for QBO + Xero, per-type dispatch): 5-7 hours total — Phase 1 SHIPPED Session 3 (commit `bffa3b16`, 3 of 11 types); Phase 2 foundation SHIPPED Session 4 (commit `635e4998`, HttpResponseError + strict dispatcher discriminator). Remaining type expansion: 5 QBO types + 3 Xero types (~3-4 hours).
- POST /transactions/:txnId/category re-implementation: 1-2 hours (once infra exists)
- POST /payments re-implementation: 2-3 hours (once thresholds + service signature fixes done)
- POST /invoices re-implementation: 3-4 hours (once charter + setup fees + dedupe wired)
- Dispatcher wiring (Phase 4c.4 stubs -> real writes): 2-3 hours
- End-to-end tests: 3-5 hours

## Context

Phase 4c.1-4c.4 (shipped Sunday May 24, 2026) built the safety architecture: pricing source of truth, threshold framework, customer dedupe with HITL escalation, and write-approval dispatcher (currently in stub mode). Phase 4c.5 re-ships the three write endpoints that were deferred on May 24 (transaction category was reverted in commit `91a554f4`; payments and invoices were never attempted) atop this safety layer.

Phase 4c.5 must address three architectural gaps documented in ADR-003 Amendment 1:
1. **Charter status storage** — `getExpectedPriceCents` requires `isCharter` parameter; no defined storage exists today
2. **Setup fees** — EA Section 7 documents one-time setup fees ($249/$349/$1,200) not modeled by Phase 4c.1 pricing schema
3. **Tier Qualifier matrix** — not codified as data (lives in agent prompts); NOT a Phase 4c.5 blocker but listed for awareness

Phase 4c.5 must also enable seeding the pricing and threshold data (Phase 4c.1b + 4c.2b) before any write endpoint can ship.

The work is bounded by the trust tenet: no real clients onboarded — including Ledgerix Pro's own books — until the system is correct, trustworthy, and dialed in for security and safety of client funds. No partial-spec compliance on safety-critical writes. Time is reference for planning, not a gate for go/no-go decisions.

## Architecture Decisions Made

(Will populate as decisions are locked during sessions. As of session 1 start, none are locked beyond what's already in ADR-002 + ADR-003.)

### Decision 1: Admin endpoint pattern for safety-layer data management

**Decided:** Session 1 (2026-05-24). **Locked.**

Use admin HTTP endpoints (e.g., `POST /api/admin/pricing/seed`, `POST /api/admin/thresholds/seed`) for all safety-layer data management — pricing, thresholds, future per-client overrides. NOT one-time TypeScript scripts.

**Reasoning:**
- Scalability: irrelevant for one-time seed but admin endpoints become the foundation for ongoing data management (per-client pricing overrides, threshold adjustments, new tier additions)
- Security: HTTP endpoints add attack surface (which scripts don't) but the board-user auth boundary is already established; the marginal security cost is small
- Auditability: REQUIRED for 7-year audit retention. Admin endpoints write to activity_log automatically; scripts only log to stdout which doesn't persist properly
- Efficacy: admin endpoints are programmatically discoverable in the API surface, support idempotent re-runs, and provide a permanent record of who-changed-what-when

The 7-year audit retention requirement (the system is being built for serious financial work) tips the decision decisively toward admin endpoints. Scripts can't deliver durable audit trails.

### Decision 2: Admin endpoint authentication — use existing assertInstanceAdmin (REVISED)

**Decided:** Session 1 (2026-05-24). **REVISED later in same session** after reading the actual auth middleware code.

Admin endpoints authenticate via the existing `assertInstanceAdmin` function in `server/src/routes/authz.ts`. This natively supports three paths:

1. **`source: "local_implicit"`** — local dev mode (auto-grants instance admin)
2. **`source: "session"`** — board user logged in via better-auth session; `isInstanceAdmin` set if user has instance admin role in DB
3. **`source: "board_key"`** — board API key bearer token; `isInstanceAdmin` set if the key's underlying user has instance admin role

All three paths capture a specific user identity in the activity log (`actor_id` = the user's ID from the auth path).

**Revision reasoning:**

The original Decision 2 proposed "session-only first, CI/CD bearer-token path committed for future." That recommendation was based on an INCORRECT assumption that board API keys were unattributed credentials. Reading `server/src/middleware/auth.ts` lines 105-115 showed the board_key path actually captures `userId: boardKey.userId` — board API keys ARE tied to specific user identities.

This means:
- The board_key path is what Decision 2 was calling "the CI/CD bearer-token path" (both are bearer-token auth with user-identity tracking)
- The existing `assertInstanceAdmin` correctly authorizes admin operations from both session AND board_key paths
- Building a separate `assertInstanceAdminSessionOnly` would create an inconsistent abstraction fighting the existing one

**What this means in practice:**

- Scott can call admin endpoints via dashboard (session path) — most common
- Scott can also use the board API key for curl / CLI calls (board_key path) — covered without additional infrastructure
- Future CI/CD automation uses the board_key (or a dedicated admin user's API key) — no separate "CI/CD path" needs to be built
- Audit log captures the specific user identity in both cases

**Memory #8 (CI/CD triggers) remains valid** but the implementation answer changed: rather than adding a new auth path when triggers occur, the work becomes "issue an API key to the appropriate user (deployment service account or otherwise) that has instance admin role." That's a user-management operation, not an auth-architecture change.

**Discovery lesson:**

This decision was originally locked without first grepping the existing auth code. The "verify before assuming" discipline (memory #7) was violated. The revision happened the same session when scaffolding began and the code was actually inspected. Future sessions: read the relevant auth code BEFORE locking auth-related decisions.

### Decision 3: Admin endpoint idempotency — Option D-modified, version-aware idempotency

**Decided:** Session 1 (2026-05-24). **Locked.**

Seed-style admin endpoints (e.g., `POST /api/admin/pricing/seed`) use version-aware idempotency. The endpoint compares submitted data against the currently-active rows and routes to one of three outcomes per row:

1. **Identical to active row** → SKIP. No DB write. Counted in response as `skipped`.
2. **Different from active row** → SUPERSEDE. Set existing row's `effective_to=now()`, INSERT new row with `effective_from=now()`. Counted as `superseded` + `newRows`.
3. **No active row exists for this key** → INSERT. New row with `effective_to=null`. Counted as `inserted`.

**Response shape:**
```json
{
  "data": {
    "inserted": N,
    "skipped": N,
    "superseded": N,
    "newRows": N
  }
}
```

**"Identical" comparison rules:**
- Compare the business-meaningful fields (e.g., for service_tier_pricing: `tier`, `is_charter`, `monthly_amount_cents`, `currency`)
- EXCLUDE: `id` (UUID, always different), `effective_from`, `effective_to`, `created_at` (metadata)
- Each schema that supports seeding defines its own "identity tuple" of fields

**Reasoning:**
- Accidental re-run is safe (identical data → skip, no damage)
- Intentional change is supported (different data → supersede with proper effective-dating)
- 7-year audit retention is preserved AS DATA, not just in activity_log
- "What was the canonical Foundation Charter price on 2026-06-15?" is answerable by querying `service_tier_pricing` with effective-dating filters — no log archaeology required
- Uses the effective-dating pattern already established in `service_tier_pricing` and `client_pricing_overrides` (consistent system semantics)

**Downsides accepted:**
- More complex implementation than simple ON CONFLICT DO NOTHING
- "Identical" requires careful per-schema definition (each seed endpoint specifies which fields to compare)
- The seed endpoint does comparison logic, making it smarter than typical seed scripts
- More test surface area (need to test all three outcomes: insert / skip / supersede)

**Implementation approach (when admin endpoints are built):**
- Helper function `compareAndSeed<T>(db, schema, identityFields, candidateRows)` encapsulates the version-aware logic
- Each specific seed endpoint (pricing, thresholds, future) calls this helper with schema-specific identity tuple
- Activity log entry per call: `actor_type=user, actor_id=<email>, action=admin.pricing.seed, details={inserted: N, skipped: N, superseded: N}`

### Decision 4: get-transaction-by-id infrastructure — Option A (full coverage)

**Decided:** Session 3 (2026-05-26). **Locked.**

Resolves Q3 (get-transaction-by-id infrastructure scope) per the path identified in Architecture Decisions Pending. Per-type fetch handlers for QBO and Xero across all transaction types listed in the WIP doc Q3 section.

**Reasoning:**

- Forcing every category update to go through HITL (Option C, previously rejected) doesn't scale. Forcing only uncommon types to HITL (Option B) creates a two-tier reliability story that's hard to reason about as the platform scales to 50+ clients.
- The current production code (`updateTransactionAccount` for QBO and Xero) already implements the pattern for ONE type per platform (Purchase / BankTransaction). Extending to all listed types means following the same pattern, not designing a new one. The marginal cost per type is bounded.
- The unified `getTransactionById` interface (locked below) gives callers a clean contract: pass txnId, get back a discriminated union including the previousAccountRef. The complexity of multi-type dispatch is contained in the implementation, not pushed to callers.
- The Phase 4c.4 dispatcher's `accounting.transaction.category_with_unknown_previous` approval type remains a fallback for truly unrecognized txnIds (e.g., types we haven't implemented yet, or platform-specific edge cases). Option A doesn't remove that safety net; it shrinks the "unknown" zone to near-zero in practice.

**Scope — types to cover:**

QBO (7 types):
- Purchase ✅ (currently in code as `updateTransactionAccount`; extract pattern into a fetch handler returning the unified shape)
- Bill
- JournalEntry
- Deposit
- BillPayment
- Payment
- Invoice (note: sales-side; account is on income lines — semantically different from expense recategorization. Treat as a separate sub-case during implementation.)

Xero (4 types):
- BankTransactions ✅ (currently in code; extract pattern)
- Invoices
- Bills
- ManualJournals

**Unified interface contract (the lock):**

```typescript
export interface TransactionLookupResult {
  txnId: string;
  platform: "quickbooks" | "xero";
  txnType: string; // e.g., "Purchase", "Bill", "BankTransaction", "Invoice"
  previousAccountRef: string | null; // null only when the txn has no recognizable account on its first line
  // Full platform-specific payload for callers that need more than previousAccountRef.
  // Shape is the same minimal-with-catch-all pattern used in QboPurchaseFull / XeroBankTransactionFull.
  raw: Record<string, unknown>;
}

export async function getTransactionById(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult>;
```

The function dispatches internally:
1. Determine the platform from `accounting_connections` (existing pattern from `updateTransactionCategory`).
2. Try each type-specific GET-by-id endpoint until one returns a 200. The error envelope from QBO/Xero distinguishes "wrong type" from "not found"; the dispatcher uses that to decide whether to try the next type or fail.
3. On success, extract `previousAccountRef` from the platform-specific shape and return the unified result.
4. On exhaustion of all types, throw `TransactionNotFoundError` — the caller (the write endpoint) routes this to `accounting.transaction.category_with_unknown_previous` approval per Phase 4c.4.

**Implementation pattern (per-type checklist):**

Each of the 11 types needs:

1. A minimal interface in `services/accounting/index.ts` (or extracted module) following the `QboPurchaseFull` / `XeroBankTransactionFull` shape — only the fields the code touches, with `[key: string]: unknown` catch-all.
2. A type-specific GET endpoint reference (verified against the official QBO or Xero API reference at implementation time — not now). The endpoint path is typically `/{TypeName}/{Id}` but worth verifying per type.
3. A function (private to the accounting module) that fetches the type and returns the unified `TransactionLookupResult`, including extracting the previousAccountRef from the type-specific line shape.
4. Registration with the central `getTransactionById` dispatcher.
5. Optionally (if the type supports it) an `updateTransactionAccount` implementation. The existing two (QBO Purchase, Xero BankTransaction) get refactored to use the new fetch handlers internally so we don't duplicate the GET-by-id logic.

**Phase 1 shipped (commit `bffa3b16`, Session 3 2026-05-26):**

The dispatcher infrastructure is live. Initial coverage: 3 of 11 types.

- New module `server/src/services/accounting/transaction-lookup.ts` (311 lines) exporting `TransactionLookupResult` interface, `TransactionNotFoundError` class, and `getTransactionById(db, companyId, contactId, txnId, hintedType?)` dispatcher per the locked interface contract above.
- Type registry initialized with 3 fetch handlers:
  - `fetchQboPurchase` — extracted from the existing `qbo.updateTransactionAccount` GET-by-id; uses `/purchase/{id}`.
  - `fetchQboBill` — NEW. Uses `/bill/{id}`. First Decision 4 type beyond the existing two.
  - `fetchXeroBankTransaction` — extracted from the existing `xero.updateTransactionAccount` GET-by-id; uses `/BankTransactions/{id}`.
- Existing `qbo.updateTransactionAccount` and `xero.updateTransactionAccount` in `services/accounting/index.ts` refactored to use the dispatcher with `hintedType` set to skip multi-type probing. Behavior is preserved; the GET-by-id is now centralized in the dispatcher. Log lines now include `previousAccountRef` from the lookup — the value that the still-deferred `POST /transactions/:txnId/category` endpoint needs to return per spec is now captured in every update's log line.
- 15 new tests in `server/src/services/accounting/transaction-lookup.test.ts`: 11 unit tests (mocked qboRequest/xeroRequest + mocked db) covering the hinted-type fast path, multi-type probing, edge cases for previousAccountRef extraction; 4 integration tests against real embedded Postgres covering platform lookup, null contactId handling, and the no-connection error path.
- Test baseline: 179 targeted tests passing (Session 3 baseline of 164 + 15 new). Full monorepo typecheck clean.

**Phase 1 captured a generalizable observation worth flagging:**

The dispatcher's multi-type probing (no hint provided) is currently single-iteration-safe because all the callers in the existing codebase provide a hint. When the first "general" caller is added (e.g., the re-implemented `POST /transactions/:txnId/category` endpoint), error discrimination becomes necessary — `qboRequest`/`xeroRequest` currently throw generic `Error` on 404 with no structured status. A 404 ("wrong type") is indistinguishable from a transient 500 in the catch handler, which could cause the dispatcher to skip a type that should have been tried again. The fix: introduce a `class HttpResponseError extends Error` with `status: number` in the platform clients, then dispatcher catches `error instanceof HttpResponseError && error.status === 404` for continue-loop semantics, rethrows everything else. Scoped to Phase 2 alongside adding the second new type per platform.

**Phase 2 foundation shipped (commit `635e4998`, Session 4 2026-05-27):**

The observation above was acted on as the first Phase 2 piece — before adding any new types.

- New module `server/src/services/accounting/http-error.ts` (32 lines) exporting `HttpResponseError extends Error` with `status: number`, `method: string`, `path: string`, optional `responseBody: string`, plus an `isNotFound` getter for the 404 case.
- `qboRequest` (`qbo-client.ts`) and `xeroRequest` (`xero-client.ts`) now throw `HttpResponseError` instead of generic `Error` on non-OK responses. Error message strings are byte-identical to the previous version (preserves debugging output and any log parsing); structured fields are purely additive. Verified backward-compatible: zero existing callers inspect error structure beyond `.message`.
- The `getTransactionById` dispatcher's multi-type probing catch block tightened from unconditional continue to strict discriminator: `if (error instanceof HttpResponseError && error.isNotFound) { continue }` else rethrow. Function-level JSDoc updated to document the Phase 2 strict semantics.
- 3 new tests in `transaction-lookup.test.ts` lock the strict discriminator: (1) 404 HttpResponseError continues to next type; (2) non-404 HttpResponseError (e.g., 500) rethrows immediately, NOT silently treated as "wrong type"; (3) non-HttpResponseError errors (network failures, malformed responses) also rethrow.
- Test baseline: 182 targeted tests passing (179 + 3 new). Full monorepo typecheck clean.

**REVISED (2026-05-27 mid-Session 4): Xero Invoice and Bill are served by the same endpoint:**

Decision 4's original locked scope listed "4 Xero types: BankTransaction, Invoices, Bills, ManualJournals" — anticipating 4 separate fetch handlers in `XERO_TYPE_REGISTRY`. Verification against the Xero Accounting API during Phase 2 type expansion surfaced a structural fact not captured in the original lock:

**Xero treats ACCREC (sales Invoice) and ACCPAY (purchase Bill) as the same resource type, served by the same endpoint (`/Invoices/{InvoiceID}`), with a `Type` field discriminator on the response (`ACCREC` vs `ACCPAY`).** This is unlike QBO, where Invoice and Bill live at separate endpoints (`/invoice/{id}` and `/bill/{id}`) and have structurally different line shapes.

Per Tenet #16 (Locked Decisions Stay Locked), the path for genuine new information is explicit revision, not silent drift. The revised implementation plan:

- One shared handler `fetchXeroInvoiceOrBill` reads `/Invoices/{txnId}` and inspects the `Type` field on the response to return `txnType: "Invoice"` (for ACCREC) or `txnType: "Bill"` (for ACCPAY).
- The handler is registered under BOTH `"Invoice"` AND `"Bill"` keys in `XERO_TYPE_REGISTRY`. The dispatcher's hinted-type path works correctly because the same handler responds either way; the unhinted-type path tries one (whichever is first in the registry) and succeeds — there is no scenario where the "wrong" type is tried since both keys map to the same handler.
- ManualJournals remains a separate handler (`fetchXeroManualJournal`) since it uses a structurally different endpoint (`/ManualJournals/{ManualJournalID}`) with `JournalLines` (not `LineItems`).

Net effect: Decision 4 still covers 4 Xero "types" from the caller's perspective (BankTransaction, Invoice, Bill, ManualJournal — all four valid `txnType` values), but the implementation uses 3 handler functions instead of 4. The locked interface contract above is unchanged — `getTransactionById` still returns the appropriate `txnType` discriminator, and the type registry still has keys for all 4 types.

This revision is documented here rather than silently implemented to preserve the audit trail for future readers wondering why `XERO_TYPE_REGISTRY` has 4 entries but only 3 handler functions.

**Mock lifecycle discovery (worth flagging for future test work):**

The strict-catch change initially broke 7 tests. Root cause was NOT the strict semantics themselves — it was `vi.clearAllMocks()` in three `beforeEach` blocks. `clearAllMocks()` clears call history but does NOT drain queued `.mockResolvedValueOnce`/`.mockRejectedValueOnce` implementations. Under the prior loose-catch dispatcher, every queued mock got consumed per test (the loop iterated through all types), so the queues happened to be empty by the next test. Under Phase 2 strict semantics, fewer mocks are consumed per test (strict rethrow short-circuits the loop on the first non-404), so leftover queued mocks leaked forward and corrupted subsequent tests. Fix: `vi.resetAllMocks()` instead of `vi.clearAllMocks()` — drains the queues correctly. Generalizable lesson: when test files use `.mockXxxValueOnce` chains, prefer `resetAllMocks()` over `clearAllMocks()` in `beforeEach`.

**Remaining Decision 4 implementation work (Phase 2+):**

- ~~Structured HTTP error class for qboRequest/xeroRequest (~30 min)~~ — DONE Session 4 (commit `635e4998`)
- ~~QBO types still to add (5): JournalEntry, Deposit, BillPayment, Payment, Invoice~~ — DONE Session 4 across 5 commits (`8830f206`, `7027c79a`, `2195544a`, `769a39ca`, `bf96d2d3`)
- **Xero types still to add (per revised plan above):**
  - `fetchXeroInvoiceOrBill` shared handler, registered under both `"Invoice"` and `"Bill"` keys (~45 min — slightly more complex than QBO due to Type discriminator logic; ~3 tests covering ACCREC path, ACCPAY path, missing-Type fallback)
  - `fetchXeroManualJournal` separate handler at `/ManualJournals/{id}` (~30 min — straightforward, similar to BankTransaction shape with JournalLines instead of LineItems)
- Tests for each Xero type added per memory #21 (registry-cardinality coupling — every new type added to XERO_TYPE_REGISTRY requires growing the Xero-side exhaustion test's mock queue and assertions)
- Remaining effort estimate: ~1.5-2 hours (down from ~3-4 hours estimated after Phase 2 foundation shipped — reflecting that QBO work is done and Xero shared-endpoint pattern reduces the per-type work)

**Out of scope for this decision (deferred to implementation):**

- The precise interface shape for each of the 11 platform-specific types. Those are determined at implementation time with the QBO / Xero API reference docs open. Pre-locking them now would be premature — small details that won't matter until code is being written.
- The 1099 / Transfer / CreditMemo and other rarer QBO types not listed in the Scope subsection above. These remain in the `accounting.transaction.category_with_unknown_previous` approval fallback. If real-world traffic surfaces a missing type, add it in a follow-up.
- The full QBO Invoice recategorization semantics. Invoices are sales-side; "recategorizing" an Invoice line affects the income account it credits. Whether that's a legitimate agent operation or always-HITL is itself a design question. Capture as a sub-decision during implementation; default to HITL if uncertain.

**Estimated implementation effort:** 5-7 hours per the original WIP doc estimate. Distribution roughly:
- Refactor existing QBO Purchase + Xero BankTransaction to the new pattern: 1-2 hours
- 6 new QBO types × ~30-45 min each (verify endpoint + minimal interface + handler + dispatcher registration): 3-4 hours
- 3 new Xero types × ~30-45 min each: 1.5-2 hours
- Integration tests against embedded Postgres + mocked QBO/Xero responses (mocks are fine here — we're not testing SQL, we're testing dispatcher logic + response shape parsing): 1 hour
- Wire up `previousAccountRef` capture in the deferred `POST /transactions/:txnId/category` endpoint: bundled into the endpoint re-implementation session, not Q3.

**Unblocks:** `POST /api/accounting/v1/transactions/:txnId/category` endpoint re-implementation (which was reverted in commit `91a554f4` for hardcoding `previousAccountRef: null`).

**Blast radius if wrong:** Low. The interface is single-purpose (txn lookup, returns previousAccountRef + raw payload). If the dispatcher logic has bugs, they manifest as either (a) a TransactionNotFoundError → approval flow (safe) or (b) an unexpected raw shape → caller-side handling. Neither propagates beyond the one endpoint.

**Verification approach when implemented:**

- Unit tests for the dispatcher: mock the platform-specific fetch handlers, verify the right one is called based on stubbed accounting_connections lookups.
- Integration tests via embedded Postgres for `accounting_connections` queries (same pattern established for compareAndSeed in Session 3).
- Per-type fetch handler tests use mocked QBO/Xero responses (the platform APIs themselves don't need to be hit during tests).
- Production verification once shipped: call `getTransactionById` against Enyrgy Inc's real Xero data for each implemented type, confirm `previousAccountRef` matches what's in the Xero UI.

## Architecture Decisions Pending

### Q1: Charter status storage mechanism (ADR-003 Amendment 1 Gap 1)

The `getExpectedPriceCents(db, tier, isCharter, contactId?)` service function shipped Phase 4c.1 requires the caller to know `isCharter`. EA Section 7.1 documents Charter Pricing Window as a persistent client-level status — Charter benefit follows the client across tier upgrades AND downgrades for as long as service is continuous, lost permanently on cancellation.

Three options from ADR-003 Amendment 1:
- **Option A:** Add GHL custom field `is_charter`. Tier assignment writes it at onboarding. Easy but introduces GHL as runtime dependency for invoicing.
- **Option B:** Add `client_charter_status` table to local DB. Captures grant date, current status (active / cancelled-was-charter / never-charter), and history. Cleanest separation; requires new schema + sync logic.
- **Option C:** Compute `isCharter` from system-wide charter cutoff timestamp + client created_at. Treats charter as derived state. Simplest; doesn't model the "cancelled-and-returned forfeits charter" rule cleanly.

**To be resolved in:** Phase 4c.5 session focused on charter status. Decision blocks Invoice endpoint re-implementation.

### Q2: Setup fee handling (ADR-003 Amendment 1 Gap 2)

EA Section 7 documents one-time setup fees ($249 Foundation / $349 Growth Engine / $1,200 Scale-Up). Phase 4c.1's `service_tier_pricing` schema only models monthly recurring. Setup fees are non-refundable except via the 30-day satisfaction guarantee — they have different billing semantics than recurring.

Three options from ADR-003 Amendment 1:
- **Option A:** Extend `service_tier_pricing` with a `pricing_type` column (`monthly_recurring` | `setup_fee`). Same table, two row types per tier. Caller filters by type.
- **Option B:** Parallel `setup_fee_pricing` table with same structure but different lookup function. Cleaner separation; more schemas to maintain.
- **Option C:** Treat setup fees as a separate concern entirely — different invoice endpoint, different audit type, different approval rules. Maximum separation.

**To be resolved in:** Phase 4c.5 session focused on invoice billing. Decision blocks Invoice endpoint re-implementation.

### ~~Q3: get-transaction-by-id infrastructure scope~~ — RESOLVED Session 3

Resolved 2026-05-26 as Decision 4 (Option A — full coverage). See Architecture Decisions Made above.

(Q4 and Q5 resolved Session 1 — see Decisions 2 and 3 above.)

## Defects Discovered

### Defect 1: compareAndSeed null-identity SQL bug (RESOLVED 2026-05-26 Session 3, commit `1727746a`)

**Symptom:** Re-running `POST /api/admin/thresholds/seed` against an already-seeded DB returned `inserted: 2, skipped: 0` (wrong) instead of the expected `inserted: 0, skipped: 2`. Each re-run creates duplicate active rows in `write_thresholds`. The pricing endpoint behaves correctly because its identity tuple `[tier, isCharter]` has no nullable fields.

**Root cause:** The helper builds its identity-match WHERE conditions with `eq(column, value)` for every identity field, including when `value` is `null`. In SQL, `column = NULL` is never true (not even `NULL = NULL`). For the thresholds seed, `ghlContactId` is `null` on canonical (global) thresholds, so the helper's lookup query never matches the existing row — it always falls into the "no active row exists" branch and re-inserts.

**Repro evidence in prod (2026-05-25):**

- 18:58:31 — Initial thresholds seed: `inserted: 2`. activity_log `99273b65-c078-45e2-8263-ebfaab0e7296`.
- 19:00:28 — Re-run thresholds seed: `inserted: 2` (BUG — should have been `skipped: 2`). activity_log `8e55d843-b23a-49fe-b457-288fa1a2d30c`.
- 19:00:30 — psql verification: 4 rows in `write_thresholds`, all with `effective_to = NULL`, 2 identical pairs.
- 19:03 — Cleanup: hard DELETE on the 2 duplicate rows from 19:00:28/29 (IDs `85f5d1a4-...` and `c704985f-...`). Original 18:58 rows retained. Activity log entries preserved (audit retention is sacred — see ADR-003).

**Why tests didn't catch this:** The mock `db.where()` in `compare-and-seed.test.ts` is a no-op pass-through — it returns the chain object without applying any SQL semantics. The mock returns whatever read result is pre-seeded for that test, regardless of what conditions were built. Net effect: the unit tests can't distinguish between "helper built the right WHERE clause" and "helper built a WHERE clause that returns nothing in real SQL." Both look identical to the mock.

The skip path tests passed because the test pre-seeded the read with the "existing row" — the helper got that row back, compared values, and skipped correctly. But the helper was finding the row only because the mock handed it over, not because the WHERE clause would have matched in real SQL.

**Fix sketch (DO NOT IMPLEMENT IN THIS SESSION — needs deliberate time):**

1. Helper change: when building identity-match conditions, if the candidate value is `null`, use `isNull(column)` instead of `eq(column, value)`.
2. Test change: either (a) replace the no-op `db.where()` mock with one that captures and replays conditions, then assert on them; or (b) write integration tests against a real DB (pglite or similar) that exercises the actual SQL semantics. Option (b) is stronger and matches how this defect surfaced in prod.

**Lesson:** Unit tests with fluent-chain mocks can verify call shape but NOT SQL semantics. For helpers that build WHERE clauses with edge cases (nulls, undefined, type coercion), integration tests against a real DB are necessary. Memory #7 (verify before assuming) applied: assumed mock-pass = SQL-correct. It doesn't.

**Blocks:** Any future admin endpoint that seeds data with nullable identity fields. Pricing endpoint (no nulls) is safe. Current `write_thresholds` data is correct (cleanup completed); future re-runs would re-introduce duplicates until the fix ships.

**Workaround until fix:** Don't re-run `/api/admin/thresholds/seed`. If thresholds need updating, do so via direct SQL or a future migration until the helper is fixed.

**Resolution (Session 3, 2026-05-26):**

- **Commit:** `1727746a` — `fix(admin,phase-4c-5): compareAndSeed null-identity SQL bug + integration tests`
- **Helper fix:** `compare-and-seed.ts` identityFields mapping now uses `isNull(column)` when the candidate value is null, instead of `eq(column, null)`. Non-null values still go through `eq` unchanged. `isNull` was already imported. 10-line explanatory comment block added above the .map() call documenting the SQL null-equality semantics and cross-referencing this Defects Discovered section.
- **Integration tests added:** New file `server/src/services/admin/compare-and-seed.integration.test.ts` with 3 tests against real embedded Postgres (via existing `startEmbeddedPostgresTestDatabase` infrastructure). Two tests directly repro the null-identity bug; one is a no-regression smoke test for the pricing path. Tests were written TDD-style BEFORE the helper fix: tests 1 and 2 failed against the unfixed helper, all 3 passed after the fix.
- **Prod verification:** Re-ran `POST /api/admin/thresholds/seed` against Railway prod on 2026-05-26 at 00:40 UTC. Result: HTTP 200, `inserted: 0, skipped: 2, superseded: 0, newRows: 0` — the exact Decision 3 idempotency contract. activity_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95` captures the post-fix re-run under admin@ledgerixpro.com's user identity. psql verified `write_thresholds` still has exactly 2 active rows (same `id`s as the 2026-05-25 initial seed), confirming no duplicates were created.
- **Audit trail:** Three `admin.thresholds.seed` entries in activity_log now tell the full bug → fix → verification story:
  - `99273b65-...` (2026-05-25 18:58) — initial seed, `inserted: 2` (correct)
  - `8e55d843-...` (2026-05-25 19:00) — buggy re-run, `inserted: 2` (should have been `skipped: 2`)
  - `e6d8b7f5-...` (2026-05-26 00:40) — post-fix re-run, `skipped: 2` (contract restored)
- **Test baseline:** 164 targeted tests passing (Session 2 baseline of 161 + 3 new integration tests). Full monorepo typecheck clean.
- **Lesson applied:** The integration test infrastructure (embedded-postgres via `startEmbeddedPostgresTestDatabase`) is now the established pattern for testing SQL-predicate helpers in this codebase. The Session 2 lesson ("mocks don't model SQL semantics") was codified as executable infrastructure, not just doc text.

## Work Done (cumulative)

- `e618231b` (Sunday 2026-05-24, Block 1) — activity_log.companyId nullable + compareAndSeed helper + this WIP doc
  - Migration 0067_last_gateway.sql: ALTER TABLE activity_log ALTER COLUMN company_id DROP NOT NULL
  - LogActivityInput type: companyId is now `string | null`
  - publishLiveEvent and PluginEvent emissions skipped when companyId is null (per Option 1)
  - compareAndSeed generic helper in server/src/services/admin/compare-and-seed.ts (no tests yet)
  - WIP doc committed with Decisions 1, 2 (revised), 3 locked

- `ff3875e8` (Monday 2026-05-25, Session 2) — Part 2: admin seed endpoints + tests
  - admin.ts route file mounted at `/api/admin/pricing/seed` and `/api/admin/thresholds/seed`
  - admin router added to app.ts alongside other instance-admin routes
  - compareAndSeed generics refactor (Option A): `TRow` defaulted to `TSchema["$inferSelect"]` so `identityFields`, `valueFields`, and `effectiveToField` get compile-time protection against typos against the actual schema. The original two-generic form inferred `TRow` from `candidateRows` (which only contains identity+value fields), so `"effectiveTo"` wasn't in the union — that was the root cause of the lines-75/144 errors.
  - Helper unit tests (7 tests) covering insert/skip/supersede/mixed paths + three error-path guards
  - Endpoint integration tests (9 tests): 3 auth-guard convergence tests (all → 403 via assertInstanceAdmin → assertBoard), pricing happy path (envelope/helper-call/audit-log), thresholds happy path, failure-path audit logging
  - 161 targeted tests passing (145 baseline + 16 new); full monorepo typecheck clean

- 2026-05-25 Session 2 end-of-day — Production bootstrap of canonical pricing + thresholds
  - `POST /api/admin/pricing/seed` → HTTP 200, `inserted: 6, skipped: 0, superseded: 0, newRows: 0`. activity_log `e6b9d177-d313-4b6f-902b-c0ac9a5fbf6f`. Verified: 6 rows in `service_tier_pricing` match canonical values.
  - `POST /api/admin/thresholds/seed` → HTTP 200, `inserted: 2`. activity_log `99273b65-c078-45e2-8263-ebfaab0e7296`. Verified: 2 rows in `write_thresholds` match canonical values.
  - Idempotency re-run exposed null-identity bug on thresholds endpoint (see Defects Discovered). Cleanup: 2 duplicate rows DELETED from `write_thresholds`. Activity_log entries preserved.
  - Bootstrap is functionally complete for both tables. Canonical data lives in prod DB under admin@ledgerixpro.com's user identity.

- `1727746a` (Tuesday 2026-05-26, Session 3) — fix(admin,phase-4c-5): compareAndSeed null-identity SQL bug + integration tests
  - Helper fix in `compare-and-seed.ts`: identityFields map now uses `isNull(column)` when candidate value is null instead of `eq(column, null)` (which never matches in SQL)
  - New integration test file `server/src/services/admin/compare-and-seed.integration.test.ts` — 3 tests against real embedded Postgres, written TDD-style (tests 1 and 2 verified to FAIL against unfixed helper before fix; all 3 PASS after)
  - 164 targeted tests passing (161 baseline + 3 integration); full monorepo typecheck clean
  - Verified end-to-end in Railway prod: `POST /api/admin/thresholds/seed` re-run returned `inserted: 0, skipped: 2`. activity_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`. psql confirmed no duplicate rows created.

## Next Steps (in order)

### COMPLETED — Session 2 (Monday 2026-05-25, commit `ff3875e8`)

1. ✅ Fix admin.ts compile errors (.ts→.js import + generics refactor for effectiveToField type errors)
2. ✅ Mount admin router in app.ts alongside other instance-admin routes
3. ✅ Write tests for admin endpoints (9 tests in `server/src/routes/admin.test.ts`)
4. ✅ Write tests for compareAndSeed helper (7 tests in `server/src/services/admin/compare-and-seed.test.ts`)
5. ✅ Full targeted test suite passing (161 tests, up from 145 baseline)
6. ✅ Commit Part 2 — `ff3875e8`

### IMMEDIATE — Next deliberate action

7. ✅ **Bootstrap canonical pricing + thresholds via the seed endpoints** — DONE Session 2 end-of-day. Both seeds executed against Railway prod, audit-logged, verified. See Work Done. Idempotency re-run exposed a defect → next item.

8. ✅ **Fix compareAndSeed null-identity bug + harden tests** — DONE Session 3 (commit `1727746a`, prod-verified via audit_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`). See Defects Discovered Defect 1 Resolution block for full story.

9. ✅ **Resolve Q3 (get-transaction-by-id infrastructure scope)** — DONE Session 3 as Decision 4 (Option A — full coverage). See Architecture Decisions Made for the locked interface contract, per-type checklist, and implementation pattern. Implementation pending (5-7 hours estimated).

10. **Implement Decision 4 (get-transaction-by-id infrastructure)** — the next deliberate code work. 5-7 hours per the Decision 4 estimate. Refactor existing QBO Purchase + Xero BankTransaction handlers to the unified pattern, add 6 new QBO types + 3 new Xero types per the checklist, integration tests via embedded Postgres + mocked QBO/Xero responses. Once shipped, the `POST /transactions/:txnId/category` endpoint becomes re-implementable.

(Q1 and Q2 remain pending, each its own focused session — they're entangled with business model considerations that deserve unhurried thought.)

### FUTURE SESSIONS

8. **Future sessions:** Resolve Q1 (charter status) and Q2 (setup fees). Each is a significant architectural piece deserving its own focused session. (Q3 resolved Session 3 as Decision 4 — implementation tracked as IMMEDIATE item 10.)

9. **Sessions 4-N:** Re-implement the three write endpoints atop the now-complete safety layer. Wire Phase 4c.4 dispatcher stubs to real upstream writes.

10. **Final session:** Move all locked decisions from this WIP doc to ADR-004, summarize in PHASE-4-PROGRESS.md, update EA + Brief, delete this WIP doc.

## Blockers

None as of session 1 start. Architectural decisions are pending but not blocking — they get resolved in the order shown in Next Steps.

## NOT Doing (deliberately)

### REJECTED: One-time TypeScript scripts for pricing + threshold seed

**Considered:** Session 1 (2026-05-24).

**Reason:** Scripts don't deliver durable audit trails. The 7-year audit retention requirement (the system is being built for serious financial work) requires that data management operations write to activity_log automatically. Stdout logs from scripts don't persist properly. Don't re-propose without addressing the audit-retention requirement.

### REJECTED: Every transaction category update creates an approval (no get-transaction-by-id)

**Considered:** Session 1 (2026-05-24).

**Reason:** Doesn't scale to 50+ client systems with many monthly category updates. The HITL approval queue would become noise; reviewers would rubber-stamp approvals; the safety guarantee degrades to a paperwork exercise. Don't re-propose without addressing the scalability concern.

### REJECTED: `previousAccountRef: null` placeholder in transaction category response

**Considered:** May 24 morning (pre-WIP doc).

**Reason:** Violates the trust tenet. Partial-spec compliance on a write endpoint that touches financial records creates exactly the kind of compromise pressure that erodes trust over time. The audit log losing the "before" value is an audit-completeness gap, not just a documentation gap. Don't re-propose without a way to capture `previousAccountRef` cleanly.

See commit `91a554f4` (the revert) and ADR-003 for the full reasoning.

## Session Log

### Session 1 — 2026-05-24 (Sunday)

**Goal:** Establish Phase 4c.5 design foundation and WIP doc.

**Architecture decisions reached:**
- Decision 1 locked: admin endpoint pattern over one-time scripts for safety-layer data management. Driven by 7-year audit retention requirement.

**Architecture decisions identified and queued for future sessions:**
- Q1 (charter status storage), Q2 (setup fee handling), Q3 (get-transaction-by-id scope), Q4 (admin endpoint auth), Q5 (admin endpoint idempotency).

**Options explicitly rejected:**
- One-time scripts for seeding (audit retention)
- Every-category-update-needs-approval (scalability)
- `previousAccountRef: null` placeholder (trust tenet)

**Discoveries:**
- The "build it right, not fast" framing fundamentally changes the architecture choices. Earlier in the session I was optimizing for "ship within the day" and proposing partial solutions. Once Scott reframed as "no time pressure; build for the final system that will handle real client funds with 7-year audit retention," admin endpoints became the obvious answer where scripts had seemed defensible 30 minutes earlier.

**State at session end:**
- WIP doc created and committed
- One architectural decision locked (Decision 1)
- 5 design questions documented for future resolution
- Phase 4c.1-4c.4 already shipped earlier in the same session (commits 104e82fb, 7fce967b, 43d6e144, e7cec441)
- 145 targeted tests pass
- No Phase 4c.5 code shipped yet — appropriate given the architectural decisions still pending

**Discipline note for future sessions:**
This WIP doc must be read at the start of every Phase 4c.5 session before any work begins. The 3 rejected options ("NOT Doing") and the locked Decisions 1, 2 (revised), 3 are not up for re-litigation. Future Claude in particular should treat this as authoritative for Phase 4c.5 architectural questions.

### Session 1 Block 1 addendum — 2026-05-24 (Sunday, before break)

**Architecture decisions resolved this block:**
- Decision 2 (admin endpoint auth) — initially locked as "session-only first, CI/CD bearer path committed for future" (Lock 1B). REVISED later in same block after reading auth middleware code: existing `assertInstanceAdmin` natively supports session, board_key, and local_implicit paths — all identity-tracked. Decision 2 now reads "use existing assertInstanceAdmin."
- Decision 3 (admin endpoint idempotency) — locked Option D-modified (version-aware). Implemented as `compareAndSeed` helper.
- Decision B (activity_log.companyId nullable) — locked. Migration 0067 shipped.
- Option 1 (skip live/plugin events for system-scoped operations) — locked. The current operations dashboard monitors agent health, not activity streams, so system-scoped admin operations don't need broadcast in real-time. Activity log query remains source of truth.

**Shipped this block:**
- Commit `e618231b`: Migration 0067 + LogActivityInput type + compareAndSeed helper + this WIP doc

**Discoveries this block:**
- The "verify before assuming" discipline (memory #7) played out twice. First when extending approvals.ts (logger not imported). Second when locking Decision 2 (assumed board_key was unattributed; turned out to be identity-tracked). Future sessions: read the relevant code BEFORE locking decisions, not after.
- The real-time dashboard at api.ledgerixpro.com/dashboard does NOT consume activity_log live events directly — it monitors agent operations. This freed up Option 1 (skip events for system-scoped operations) as the right answer rather than requiring more infrastructure work.

**State at block end:**
- 10 commits shipped today (4c.1 through Part 1 of 4c.5)
- 145 targeted tests still passing
- admin.ts file drafted but has 3 typecheck errors — intentionally uncommitted
- Phase 4c.5 has WIP doc + Decisions 1, 2 (revised), 3, B + helper module + nullable companyId migration
- Block 2 (after break) picks up at "Fix admin.ts compile errors" per Next Steps section above

### Session 1 Block 2 — 2026-05-24 (Sunday, after break — DID NOT OCCUR)

**Honest status:** Block 2 was planned for ~2 hours of post-break work covering admin.ts compile fixes, router mounting, test coverage, and end-of-day documentation. After the 3-hour break, Scott returned and decided to end the work day rather than proceed with code work. End-of-day documentation pass occurred instead (PHASE-4-PROGRESS.md update + this WIP doc closure + EA/Brief content drafting).

**Why this matters for future sessions:** The planned Block 2 work (admin.ts fixes, router mount, tests) was NOT done. The admin.ts file remains uncommitted in the working tree with 3 typecheck errors. The Block 2 todo list at "Next Steps (in order) — IMMEDIATE — Block 2" is still the correct starting point for the next session.

**State at session end (Sunday 2026-05-24 final):**
- Codebase HEAD: master @ <post-doc-update commit>
- 12 commits shipped today (11 net forward; 1 reverted)
- 145 targeted tests passing
- Phase 4c.5 Part 1 shipped; Part 2 ready to pick up exactly as documented in IMMEDIATE Next Steps
- admin.ts file in working tree, intentionally uncommitted, 3 typecheck errors documented
- WIP doc + tracker + EA + Brief all reflect Sunday's actual work

### Session 2 — 2026-05-25 (Monday)

**Goal:** Complete Phase 4c.5 Part 2 — admin endpoint compile fixes, router mount, test coverage, commit.

**Architecture decisions reached:**
- None new. The Decision 2 (revised) auth pattern and Decision 3 idempotency pattern from Session 1 were applied without re-litigation.

**Implementation decisions worth flagging:**
- **compareAndSeed generics refactor (Option A vs B vs C):** The two original generics `<TSchema extends PgTable, TRow>` caused the lines-75/144 type errors because `TRow` was inferred from `candidateRows` (which only contains identity+value fields), so `"effectiveTo"` wasn't in `keyof TRow & string`. Three fixes were considered: (A) default `TRow` to `TSchema["$inferSelect"]` so it derives from the table's full row shape; (B) widen `candidateRows` to require optional `effectiveTo`/`id` at every call site; (C) loosen `effectiveToField` to plain `string`. Chose (A) because it's the closest match to the helper's design intent — the runtime guards check column existence on the table, and the compile-time type should reflect that the keys must be table columns, not candidate-row keys. Verified with grep that `$inferSelect` is the standard codebase pattern (used in access.ts, xero-client.ts, qbo-client.ts, write-approvals.ts, execution-workspaces.ts).

**Discoveries:**
- The Block 2 todo list from Sunday was specific enough that Session 2 picked up cleanly without re-deriving context. WIP doc convention worked as designed.
- Memory #7 (verify before assuming) played out three times this session: (a) verified $inferSelect is the codebase pattern before refactoring; (b) verified mock chain shape against actual helper behavior by running tests rather than assuming; (c) caught my own wrong assumption about the 401-vs-403 auth path by reading what assertInstanceAdmin actually does (it short-circuits via assertBoard, so `type === "none"` returns 403, not 401).
- Bootstrap step was deferred mid-session when I asked which DB the local dev server points at and Scott noted the dev env isn't isolated from prod (memory #1 TODO). Avoided a sleepwalk into a side-effectful prod write disguised as local dev.

**State at session end:**
- Codebase HEAD: master @ `ff3875e8` (pushed to GitHub master)
- 161 targeted tests passing (145 baseline + 16 new)
- Full monorepo typecheck clean
- Phase 4c.5 Part 2 complete; bootstrap deferred as the next deliberate action
- WIP doc + tracker pending end-of-session update (this commit)

**Working style notes captured to memory:**
- Memory #10 added: One action per turn, ALWAYS labeled with exact destination (Terminal vs Claude Code prompt). For Claude Code prompts, the entire pasteable block wrapped between explicit markers inside one code fence so Scott can copy as a unit without parsing what's instruction vs commentary.
- Memory #11 added: Decision framing — always present options as numbered A/B/C with pros/cons and explicit recommendation, even for small decisions like commit structure. Don't describe a choice neutrally; frame it as a decision with tradeoffs.

### Session 2 end-of-day addendum — Production bootstrap + defect discovery

**Goal:** Bootstrap canonical pricing + thresholds in prod via the seed endpoints we just shipped. Verify the full audit trail working end-to-end.

**Pre-flight verification (memory #7 cashed in):**
- HTTP probe against `/api/admin/pricing/seed` (POST, no auth) returned `403 {"error":"Board access required"}` — confirmed deploy of `ff3875e8` is live on Railway.
- psql query against Railway prod confirmed the single board_api_keys row ("Railway Admin Key") is owned by admin@ledgerixpro.com, has instance_admin role, is unrevoked, unexpired.
- psql query confirmed `service_tier_pricing` and `write_thresholds` both empty at start (clean bootstrap state).

**Bootstrap execution:**
- Pricing seed: HTTP 200, `inserted: 6, skipped: 0`. psql verified 6 rows match canonical values. activity_log entry verified with `actor_id = admin@ledgerixpro.com's user ID`, `company_id = NULL` (system-scoped per Decision B), `status = success`, full result in `details`.
- Thresholds seed: HTTP 200, `inserted: 2, skipped: 0`. psql verified 2 rows match canonical EA Section 6.3 values. activity_log entry verified.

**Idempotency re-run + defect discovery:**
- Re-ran pricing seed: HTTP 200, `inserted: 0, skipped: 6, superseded: 0, newRows: 0`. Decision 3 contract held for pricing. ✅
- Re-ran thresholds seed: HTTP 200, `inserted: 2, skipped: 0` (BUG — should have been `inserted: 0, skipped: 2`).
- Root cause traced to `eq(col, null)` semantics in SQL (never matches NULL). See Defects Discovered, Defect 1.
- Cleanup: 2 duplicate rows in `write_thresholds` hard-DELETED. activity_log entries preserved (audit retention is sacred per ADR-003).

**Real lesson — mocks don't model SQL semantics:**
- The unit tests in `compare-and-seed.test.ts` passed because the mock `db.where()` is a no-op pass-through. The mock returns whatever the test pre-seeded, regardless of what WHERE conditions were built.
- A test can prove "helper called .where()" but not "helper built a WHERE that would match in real SQL."
- For helpers that build SQL predicates with edge cases (nulls, type coercion, complex joins), integration tests against a real DB are necessary. This is a generalizable lesson, not specific to compareAndSeed.

**Discoveries:**
- Project attachment .docx files in `/mnt/project/` are stale relative to the .md source-of-truth in `docs/`. Scott noted EA v3.4 / Brief v1.4 are current; attached .docx files are pre-conversion artifacts.
- The full audit-log story for Phase 4c.5 works end-to-end. From `actor_id` to `details`, every field captures intent correctly. The 7-year audit retention design pays off.

**State at session end:**
- Codebase HEAD: master @ `87773e76` (will be `+1` after this WIP doc + tracker update)
- 161 targeted tests passing (no regression)
- `service_tier_pricing`: 6 active rows, canonical, verified
- `write_thresholds`: 2 active rows, canonical, verified (post-cleanup)
- `activity_log`: 4 admin-operation entries (2 pricing seeds, 2 thresholds seeds — original + buggy re-run for each). Permanent audit trail.
- Phase 4c.5 bootstrap complete; null-identity defect documented; fix is the next IMMEDIATE work item.
