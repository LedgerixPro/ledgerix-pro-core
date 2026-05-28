# WIP: Phase 4c.5 — Re-ship Write Endpoints Atop Safety Layer + Admin API Foundation

**Status:** in_progress
**Started:** 2026-05-24
**Last updated:** 2026-05-28 Session 5 (Decision 7 — POST /invoices — DESIGN LOCKED; Q-inv-1/2/3 + sub-decisions locked; implementation Pieces H/I/J/K defined; not yet implemented)
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
- ~~Implement Decision 4 (get-transaction-by-id infrastructure for QBO + Xero, per-type dispatch): 5-7 hours total~~ — **COMPLETE Session 4 (2026-05-27)**. Phase 1 shipped commit `bffa3b16` (dispatcher + 3 types). Phase 2 foundation shipped commit `635e4998` (HttpResponseError + strict dispatcher). Phase 2 type expansion shipped across 6 commits: `8830f206` (JournalEntry), `7027c79a` (Deposit), `2195544a` (BillPayment), `769a39ca` (Payment), `bf96d2d3` (Invoice — QBO half complete), `4e9d70be` (Xero Invoice/Bill/ManualJournal — feature-complete). Dispatcher now covers all 11 planned types: 7 QBO handlers + 3 Xero handlers (Xero Invoice/Bill share a handler per the REVISED note below). Test baseline 161 → 198 (+37).
- ~~Implement Decision 5 (write-side dispatcher for transaction category updates): ~3-4 hours total~~ — **COMPLETE Session 4 (2026-05-27)**. Foundation shipped commit `69505e90` (transaction-write.ts module + dispatcher + TransactionTypeNotCategorizableError class + 8 tests). 5 per-type handlers shipped across 5 commits: `d90d5304` (QBO Purchase), `034ac5c4` (QBO Bill, shared QboAccountBasedExpenseTxnForWrite interface), `eb77d817` (QBO Deposit, QBO half complete), `5f30c3b2` (Xero BankTransaction), `e7ee3273` (Xero Invoice/Bill shared, Decision 5 feature-complete). Final integration shipped commit `b7da7478` (legacy qbo.updateTransactionAccount + xero.updateTransactionAccount deleted; hintedType parameter added to updateTransactionCategory). 6 type keys covered by 5 handler functions (Xero Invoice/Bill share); 5 excluded types throw TransactionTypeNotCategorizableError. Test baseline 198 → 224 (+26).
- ~~Implement POST /api/accounting/v1/transactions/:txnId/category endpoint (~1-2 hours)~~ — **COMPLETE Session 4 (2026-05-27)**. Pieces A+B+C shipped:
  * Piece A (commit `b7da7478`): Decision 5 final integration — already counted above.
  * Piece B (commit `001d547f`): executeApprovedAccountingWrite's TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS case wired to the dispatcher per ADR-003 Q2 replay-from-payload design intent. New "write_failed_replay" action enum value added. +3 tests (227 total).
  * Piece C (commit `bfc8549d`): POST /transactions/:txnId/category route ships end-to-end. URL+body validation, assertCompanyAccess, withIdempotency wrapping (ADR-003 Q5), three response paths (200 success / 202 approval / 400 not categorizable), separated requestedByUserId/requestedByAgentId per actor type (FK safety fix caught pre-commit). +6 tests (233 total).
- ~~POST /payments re-implementation: 2-3 hours (once thresholds + service signature fixes done)~~ — **SCOPE REVISED 2026-05-27 Session 4: Decision 6 locked.** The original "service signature fixes" phrase under-specified the work. Pre-implementation verification surfaced that the existing `reconcilePayment` has zero external callers, no threshold integration, no idempotency wiring, returns void (deviating from in-file convention), and uses an overloaded `entityRef` parameter. Decision 6 locks the service refactor + threshold wiring + approval-replay wiring + route as a single coordinated arc across 4 pieces (D/E/F/G) parallel to Decision 5's Pieces A/B/C. Estimated total: ~3-4 hours.
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

**Decision 4 COMPLETE (2026-05-27 end-of-Session-4):**

All 11 planned transaction types are now covered by the `getTransactionById` dispatcher. The implementation arc spans two sessions and roughly two-thirds of a calendar day:

- **Session 3 (2026-05-26):** Decision locked → Phase 1 shipped (commit `bffa3b16` — dispatcher + 3 types: QBO Purchase, QBO Bill, Xero BankTransaction; 15 new tests; baseline 164 → 179).
- **Session 4 (2026-05-27):** Phase 2 foundation shipped (commit `635e4998` — HttpResponseError class + strict dispatcher discriminator; 3 new tests; baseline 179 → 182) → Phase 2 type expansion shipped across 6 incremental commits:
  - `8830f206` QBO JournalEntry (1 test; baseline 182 → 183)
  - `7027c79a` QBO Deposit (1 test; baseline 183 → 184)
  - `2195544a` QBO BillPayment (3 tests covering Check/CreditCard/unknown PayType branches; baseline 184 → 187)
  - `769a39ca` QBO Payment (3 tests covering DepositToAccountRef/ARAccountRef fallback chain; baseline 187 → 190)
  - `bf96d2d3` QBO Invoice (3 tests covering SubTotal filtering + ItemAccountRef extraction; baseline 190 → 193) — **QBO half complete**
  - `4e9d70be` Xero Invoice + Bill + ManualJournal (5 tests covering ACCREC/ACCPAY discrimination + ManualJournal happy path + empty-lines fallback; baseline 193 → 198) — **FULL COMPLETE**

The pattern that worked across all 6 type-expansion commits: (a) verify the QBO/Xero API field path against current docs before writing code; (b) implement one type per commit with documented design choices in JSDoc on the handler; (c) lock each code path with a dedicated test; (d) update the type-exhaustion test in parallel per memory #21 (registry-cardinality coupling). Path Y (one commit per type) was the right discipline — each commit isolated one structural pattern, and verification against API docs caught one significant revision (the Xero shared-endpoint discovery, captured in the REVISED note below).

**Final coverage:**

| Platform | Type            | Handler                       | Endpoint                  | Notes |
|----------|-----------------|-------------------------------|---------------------------|-------|
| QBO      | Purchase        | fetchQboPurchase              | /purchase/{id}            | Phase 1 |
| QBO      | Bill            | fetchQboBill                  | /bill/{id}                | Phase 1 |
| QBO      | JournalEntry    | fetchQboJournalEntry          | /journalentry/{id}        | First-line approximation |
| QBO      | Deposit         | fetchQboDeposit               | /deposit/{id}             | Per-line source captured (not destination) |
| QBO      | BillPayment     | fetchQboBillPayment           | /billpayment/{id}         | PayType-discriminated; defensive null |
| QBO      | Payment         | fetchQboPayment               | /payment/{id}             | DepositToAccountRef → ARAccountRef fallback |
| QBO      | Invoice         | fetchQboInvoice               | /invoice/{id}             | SubTotal/Description line filtering; ItemAccountRef |
| Xero     | BankTransaction | fetchXeroBankTransaction      | /BankTransactions/{id}    | Phase 1 |
| Xero     | Invoice         | fetchXeroInvoiceOrBill        | /Invoices/{id}            | Shared handler with Bill; Type=ACCREC |
| Xero     | Bill            | fetchXeroInvoiceOrBill        | /Invoices/{id}            | Shared handler with Invoice; Type=ACCPAY |
| Xero     | ManualJournal   | fetchXeroManualJournal        | /ManualJournals/{id}      | First-line approximation |

**Net implementation:** 11 type keys in registries (7 QBO + 4 Xero) covered by 10 handler functions (7 QBO + 3 Xero — the shared-handler pattern saved one Xero handler). See the REVISED note below for why Xero needed fewer handlers than type keys.

**Test discipline observation worth keeping:** Every handler ships with at least one dedicated test, and handlers with multiple code paths ship with one test per path (BillPayment got 3, Payment got 3, QBO Invoice got 3, Xero Invoice/Bill/ManualJournal contributed 5 between them). The total +37 tests across Decision 4 is high signal — each one locks a specific extraction pattern or fallback branch.

**Decision 4 unblocks:** `POST /transactions/:txnId/category` re-implementation, which was the gating dependency captured in ADR-003's Phase 4c.5 deferred-endpoint list. The next-natural-step work item is now that endpoint plus the remaining Q1/Q2 architectural decisions (charter status storage; setup fee handling).

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

All items SHIPPED Session 4. Decision 4 is feature-complete.

- ~~Structured HTTP error class for qboRequest/xeroRequest~~ — DONE Session 4 (commit `635e4998`)
- ~~QBO types still to add (5): JournalEntry, Deposit, BillPayment, Payment, Invoice~~ — DONE Session 4 across 5 commits (`8830f206`, `7027c79a`, `2195544a`, `769a39ca`, `bf96d2d3`)
- ~~Xero types still to add: shared Invoice/Bill handler + separate ManualJournal handler~~ — DONE Session 4 (commit `4e9d70be` — 5 new tests covering ACCREC/ACCPAY discrimination, defensive default, ManualJournal happy path, empty-lines null fallback)
- ~~Tests for each type per memory #21 (registry-cardinality coupling)~~ — DONE inline with each type-expansion commit. The Xero side does not have a dedicated exhaustion test (one would be a future test-architecture improvement, but not in scope for Decision 4 feature completion).

**Next-natural-step Phase 4c.5 work** (no longer gated by Decision 4):

- `POST /transactions/:txnId/category` re-implementation (~1-2 hours) — atop the safety layer; uses the dispatcher's general (no-hint) probe path which now covers all 11 types correctly per Phase 2 strict-discriminator semantics
- Q1: Charter status storage decision + implementation (~3-5 hours, blocks Invoice endpoint)
- Q2: Setup fee handling decision + implementation (~3-5 hours, blocks Invoice endpoint)
- `POST /payments` re-implementation (~3-4 hours per Decision 6; LOCKED 2026-05-27 Session 4 — see Decision 6 above)
- `POST /invoices` re-implementation (~3-4 hours, blocked on Q1 + Q2)

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

---

### Decision 5: Write-side dispatcher scope (locked 2026-05-27 mid-Session 4)

**Locked.** Per-type write handlers behind a unified `updateTransactionCategory` dispatcher. Covers 6 of 11 transaction types from Decision 4 — the asymmetry is by design and matches QBO/Xero API reality.

**Background and reasoning:**

Decision 4 (read-side) ships per-type `fetchXxx` handlers behind `getTransactionById`, covering all 11 transaction types so writes can capture `previousAccountRef` for audit trails. Decision 5 is the WRITE-side counterpart: it ships per-type `updateXxxAccount` handlers behind `updateTransactionCategory`, dispatching from a registry similar to Decision 4's `QBO_TYPE_REGISTRY` / `XERO_TYPE_REGISTRY`.

A naive symmetric approach would replicate Decision 4's 11-type coverage on the write side. Verification against QBO/Xero APIs surfaced two reasons that doesn't work:

1. **Some types don't have a meaningful "category" to update.** For BillPayment and Payment, the relevant account refs are top-level (CheckPayment.BankAccountRef, DepositToAccountRef, ARAccountRef) — re-categorizing means reassigning the funds-source or funds-destination, not categorizing the transaction. For QBO Invoice, the line account refs come from Items (Item → income account mapping), so changing the category requires reassigning the Item, not directly editing the AccountRef.

2. **Multi-line journals require Debit/Credit balance preservation.** For JournalEntry and ManualJournal, updating only the first line's AccountRef would break the journal's balance. Safe write semantics require either updating offsetting lines simultaneously or constraining the operation to specific cases (e.g., single-line journals only). This is its own architectural problem and warrants its own decision.

**Per Tenet #14 (Trust Tenet)** — "no partial-spec compliance on safety-critical write endpoints" — Decision 5 is scoped to the types where category-update writes are safe and well-defined. Unsupported types are explicitly enumerated below; multi-line journals are deferred to a future Q5 decision.

**Scope — types IN Decision 5 (6 types, write registry):**

| Platform | Type            | Write endpoint                  | Field to mutate                                |
|----------|-----------------|---------------------------------|------------------------------------------------|
| QBO      | Purchase        | POST /purchase?operation=update | Line[0].AccountBasedExpenseLineDetail.AccountRef |
| QBO      | Bill            | POST /bill?operation=update     | Line[0].AccountBasedExpenseLineDetail.AccountRef |
| QBO      | Deposit         | POST /deposit?operation=update  | Line[0].DepositLineDetail.AccountRef           |
| Xero     | BankTransaction | POST /BankTransactions          | LineItems[0].AccountCode                       |
| Xero     | Invoice (ACCREC)| POST /Invoices                  | LineItems[0].AccountCode                       |
| Xero     | Bill (ACCPAY)   | POST /Invoices                  | LineItems[0].AccountCode                       |

Note: Xero Invoice and Bill share the same write endpoint, mirroring the read-side shared-handler pattern from Decision 4's REVISED note. The same `updateXeroInvoiceOrBill` handler will serve both registry keys.

**Scope — types EXPLICITLY EXCLUDED from Decision 5 (5 types):**

| Type             | Why excluded                                                                          |
|------------------|---------------------------------------------------------------------------------------|
| QBO BillPayment  | Account refs are top-level (CheckPayment.BankAccountRef OR CreditCardPayment.CCAccountRef) — not a "category" to categorize but a funds-source to reassign. Distinct operation. |
| QBO Payment      | Same as BillPayment — top-level DepositToAccountRef / ARAccountRef are funds-flow accounts, not categorization. |
| QBO Invoice      | Line account refs come from Items (`ItemRef` → ItemAccountRef on GET only). Changing the account requires reassigning the Item or editing the Item itself — not a direct AccountRef edit. |
| QBO JournalEntry | Multi-line Debit/Credit pairing — updating one line breaks balance. Deferred to Q5 decision. |
| Xero ManualJournal | Same as QBO JournalEntry — multi-line Debit/Credit pairing. Deferred to Q5 decision. |

**Unified interface contract:**

```ts
interface UpdateTransactionCategoryResult {
  platform: "quickbooks" | "xero";
  txnType: string;
  txnId: string;
  previousAccountRef: string | null;
  newAccountRef: string;
}

// Thrown by updateTransactionCategory when the type returned by the read
// dispatcher is not in the write registry. Distinct from TransactionNotFoundError
// (which is thrown by getTransactionById when no platform GET succeeds).
export class TransactionTypeNotCategorizableError extends Error {
  constructor(
    public readonly platform: "quickbooks" | "xero",
    public readonly txnType: string,
    public readonly txnId: string,
  ) {
    super(`Transaction type ${platform}.${txnType} (txnId=${txnId}) does not support category updates. See Decision 5 in WIP doc for the supported-type list.`);
    this.name = "TransactionTypeNotCategorizableError";
  }
}

export async function updateTransactionCategory(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
  newAccountRef: string,
): Promise<UpdateTransactionCategoryResult>;
```

**Locked behavior:**

1. Call `getTransactionById(db, companyId, contactId, txnId)` — Decision 4 dispatcher returns the transaction with its `previousAccountRef` and resolved `txnType`.
2. Look up the write handler in the appropriate `QBO_WRITE_REGISTRY` or `XERO_WRITE_REGISTRY` (keyed by `txnType`).
3. If no write handler is registered for this type → throw `TransactionTypeNotCategorizableError`. Endpoint callers map this to HTTP 400 with a clear "type not supported" message.
4. If a write handler exists → call it with the lookup's `raw` field, the `newAccountRef`, and the existing platform clients (`qboRequest`/`xeroRequest`).
5. The write handler mutates the relevant line field in the `raw` object and POSTs the update to the platform.
6. Return `UpdateTransactionCategoryResult` with `previousAccountRef` from the lookup, `newAccountRef` passed through, and the resolved `platform` + `txnType`.

**Implementation pattern (mirrors Decision 4's Path Y discipline):**

For each of the 6 supported types:
1. A `WriteHandler` function (`updateQboPurchaseAccount`, `updateXeroBankTransactionAccount`, etc.) that takes the lookup result + new account ref + platform clients.
2. Registration in `QBO_WRITE_REGISTRY` or `XERO_WRITE_REGISTRY`.
3. Per-handler unit tests covering the happy path + any platform-specific quirks.
4. The existing single-type write functions in `services/accounting/index.ts` (`qbo.updateTransactionAccount` for Purchase only, `xero.updateTransactionAccount` for BankTransaction only) are refactored to use the new dispatcher with `hintedType` set, matching the Decision 4 read-side refactor pattern.

**Out of scope for Decision 5 (deferred):**

- **Q5: Multi-line journal write semantics.** JournalEntry (QBO) and ManualJournal (Xero) writes require Debit/Credit balance preservation logic. Architectural problem worth its own decision. Pending.
- BillPayment / Payment / QBO Invoice category-update semantics — these types fundamentally don't fit a "category update" operation; if a future use case emerges (e.g., reassigning a Payment's destination account), it would be a separate endpoint with different semantics, not an extension of Decision 5.
- Bulk category updates (categorize multiple txns in one call). Single-transaction scope only for v1.

**Blast radius:**

- New code: `transaction-write.ts` module (or extension to `transaction-lookup.ts`) with the write registries and 5 handler functions (Xero Invoice + Bill share one handler — 6 supported types, 5 handler functions).
- Refactor: `qbo.updateTransactionAccount` and `xero.updateTransactionAccount` in `services/accounting/index.ts` to use the new dispatcher with `hintedType` set. These functions are currently called only by Phase 1's Decision 4 refactor and existing bookkeeping agent paths.
- Existing service-level `updateTransactionCategory` (line ~1745 of `services/accounting/index.ts`) gets significantly rewritten — currently type-narrow with the obsolete "v1 limitation" docstring; becomes the public-facing dispatcher caller.
- Tests: at minimum 6 new write-handler tests + dispatcher orchestration tests + `TransactionTypeNotCategorizableError` tests for the 5 unsupported types (verify the right error gets thrown).

**Verification approach:**

For each supported type, verify the write endpoint and field mutation against the QBO/Xero API docs BEFORE writing the handler. Path Y discipline from Decision 4: one type per commit (or tight batched commits where structurally identical), API verification before code, dedicated tests per code path. The dispatcher's behavior on unsupported types gets dedicated tests too — `TransactionTypeNotCategorizableError` must be thrown with the right platform/txnType/txnId for each of the 5 excluded types.

**Estimated effort:** ~3-4 hours for full Decision 5 implementation (dispatcher + 5 handlers + tests + service-layer integration). Less than Decision 4's effort because read-side dispatcher patterns are now established and the per-handler work is mechanical.

**Decision 5 unblocks:** The POST /transactions/:txnId/category endpoint re-implementation. Once Decision 5 ships, the endpoint becomes a thin wrapper around `updateTransactionCategory` with: success → 200, `TransactionNotFoundError` → 202 + approval creation, `TransactionTypeNotCategorizableError` → 400.

**Decision 5 COMPLETE (2026-05-27 end-of-Session-4):**

All 6 in-scope Decision 5 transaction types are now writable through the unified `updateTransactionCategory` dispatcher. Implementation arc shipped in a single session over 10 commits:

| Commit       | What shipped                                                                                |
|--------------|---------------------------------------------------------------------------------------------|
| `07c056e5`   | docs(wip): Decision 5 LOCKED — write-side dispatcher scope                                  |
| `69505e90`   | Foundation: transaction-write.ts module + dispatcher + TransactionTypeNotCategorizableError |
| `d90d5304`   | Handler #1: QBO Purchase                                                                    |
| `034ac5c4`   | Handler #2: QBO Bill (introduced shared QboAccountBasedExpenseTxnForWrite interface)        |
| `eb77d817`   | Handler #3: QBO Deposit (QBO half complete)                                                 |
| `5f30c3b2`   | Handler #4: Xero BankTransaction                                                            |
| `e7ee3273`   | Handler #5: Xero Invoice/Bill shared (Decision 5 FEATURE-COMPLETE)                          |
| `b7da7478`   | Piece A: final integration — delete legacy methods, add hintedType parameter                |
| `001d547f`   | Piece B: wire TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS approval to dispatcher                  |
| `bfc8549d`   | Piece C: POST /transactions/:txnId/category route SHIPPED end-to-end                        |

**Final coverage:**

| Platform | Type Keys                          | Handler Functions                                              |
|----------|------------------------------------|----------------------------------------------------------------|
| QBO      | 3 (Purchase, Bill, Deposit)        | 3                                                              |
| Xero     | 3 (BankTransaction, Invoice, Bill) | 2 (Invoice + Bill share updateXeroInvoiceOrBillAccount)        |
| **Total**| **6 type keys**                    | **5 handler functions** (shared-handler savings — same pattern as Decision 4) |

5 EXCLUDED types correctly throw `TransactionTypeNotCategorizableError`:
- QBO BillPayment (top-level discriminated funds-source, not a category)
- QBO Payment (top-level funds-flow accounts, not a category)
- QBO Invoice (Item-based account mapping, not direct AccountRef edit)
- QBO JournalEntry (multi-line Debit/Credit balance preservation — deferred to Q5)
- Xero ManualJournal (same as QBO JournalEntry — deferred to Q5)

**Test trajectory across Decision 5 arc:** 198 (Decision 4 close) → 224 (Decision 5 implementation) → 227 (Piece B) → 233 (Piece C). +35 tests across Decision 5 + Pieces A/B/C.

**End-to-end paths now operational:**
1. **Direct programmatic caller:** `updateTransactionCategory(db, companyId, contactId, txnId, newAccountRef, hintedType?)` from transaction-write.ts. The single canonical write entry point.
2. **HTTP endpoint:** `POST /api/accounting/v1/transactions/:txnId/category` with full ADR-003 Q4 + Q5 compliance (202 approval shape, idempotency replay support).
3. **Approval-replay path:** Approved `accounting.transaction.category_with_unknown_previous` rows trigger `updateTransactionCategory` via `executeApprovedAccountingWrite`. Three execution outcomes captured via the new `write_failed_replay` action enum value.

**FK safety fix (caught pre-commit during Piece C):** Initial implementation conflated `requestedByUserId` with `actorId` (which is derived from BOTH actor.userId and actor.agentId). Would have written agentId into a users-FK field in production. Fixed by explicit per-actor-type derivation; new agent-actor test locks the separation.

**Decision 5 unblocks Phase 4c.5 endpoint roadmap:** The category endpoint is now the first fully-functional Phase 4c.5 write endpoint. POST /payments and POST /invoices remain gated on Q1 (charter status) + Q2 (setup fees) architectural decisions, NOT on dispatcher work.

### Decision 6: POST /payments scope (LOCKED + FEATURE-COMPLETE 2026-05-27 Session 4)

The write-side dispatcher for payment-to-invoice reconciliation. Q-pay-1 / Q-pay-2 / Q-pay-3 surfaced during pre-implementation verification of the existing `reconcilePayment` function (services/accounting/index.ts:1680) and were locked together as Decision 6 to give /payments the same locked-contract footing Decision 5 gave /category.

**Pre-implementation findings (Tenet #7 verification):**

Six assumptions verified during pre-lock investigation. All six confirmed:
1. `reconcilePayment` has zero external callers across the monorepo (server, scripts, packages, tests). Same orphaned-dispatcher situation as the pre-Piece-A legacy `updateTransactionAccount` methods.
2. `entityRef` parameter is overloaded — CustomerId for QBO, AccountID for Xero. Same name, different semantics, no type-system protection against misuse.
3. No threshold integration anywhere in services/accounting/index.ts (the Phase 4c.2 threshold framework exists but is not wired into payment flows).
4. No idempotency code in the service module.
5. `applyPaymentToInvoice` returns `void` — discards the platform-assigned Payment ID. This deviates from the codebase convention: 17+ other functions in the same file capture the qboRequest/xeroRequest return value with typed shapes.
6. Decision 4/5 established the platform-inference pattern (transaction-lookup.ts:717 queries accountingConnections to resolve platform from `(companyId, contactId)`).

**Existing payload contract (PaymentThresholdExceededPayload) constrains Decision 6:**

The `accounting.payment.threshold_exceeded` approval type was defined in Phase 4c.4 (commit `e7cec441`). Its payload locks several fields that the implementation must honor:

```ts
interface PaymentThresholdExceededPayload extends BaseAccountingPayload {
  // BaseAccountingPayload: companyId, contactId, reason?, idempotencyKey?
  requestType: "POST /api/accounting/v1/payments";
  invoiceId: string;
  amount: number;                              // in cents
  paymentDate?: string;                        // ISO YYYY-MM-DD
  entityRef?: string;
  thresholdAmount: number;
  expectedRange?: { min: number; max: number };
}
```

The payload's `entityRef` is single-field (overloaded), `amount` is in cents, and `paymentDate` is ISO date. The presence of `thresholdAmount` + `expectedRange` confirms that the route layer (which creates the approval row) is responsible for the threshold check.

**Three Q-pay decisions locked:**

#### Q-pay-1: Platform inference (LOCKED — service infers platform from DB)

**Decision:** `reconcilePayment` infers platform from the `accountingConnections` table lookup for `(companyId, contactId)`. The function signature drops the `platform` parameter.

**Rationale:**
- Matches Decision 4 (`getTransactionById`) and Decision 5 (`updateTransactionCategory`) established pattern
- Caller convenience: agents and route handlers don't need to know platform to call the service
- Enables payload re-execution (Q-pay-5): the approval-replay path in `executeApprovedAccountingWrite` can call `reconcilePayment` with just `(companyId, contactId, ...)` from the payload — no platform extraction needed

**Rejected:** Keep `platform` as a required parameter. Cons: forces every caller to do a connection lookup OR pass through opaque platform strings; diverges from established pattern.

#### Q-pay-2: entityRef shape (LOCKED — split service signature, payload preserved)

**Decision:**
- The service signature splits `entityRef` into two typed optional parameters: `customerId?: string` (QBO) + `accountId?: string` (Xero). The service validates that exactly one is provided based on the resolved platform; throws a typed error otherwise.
- The payload contract (`PaymentThresholdExceededPayload.entityRef`) is preserved — single field, overloaded. Per ADR-003 Q2 ("payloads must be self-sufficient... re-executable from the payload alone"), the payload is the contract for serialization; changing it would require an Amendment.
- The route handler translates between payload and service: reads payload's `entityRef`, resolves platform via the same connection lookup the service will use, then calls `reconcilePayment(... , platform === "quickbooks" ? { customerId: entityRef } : { accountId: entityRef })`. Translation seam is at the route, not the service.

**Rationale:**
- Service stays type-safe: a QBO call cannot accidentally pass an Xero AccountID into `customerId` (different types would mean a typecheck error in test setup)
- Payload stays serializable per ADR-003 Q2: a single string field is simpler for the approval-replay path
- The translation logic lives in exactly ONE place (the route handler), is small, and is testable in isolation

**Rejected:**
- Keep `entityRef` overloaded in both payload and service (Option A in pre-lock discussion). Cons: footgun preserved end-to-end; no type-system protection in test setup; future agent callers can pass the wrong ID type without a typecheck error.
- Change the payload to split (Option C). Cons: amends ADR-003-locked payload contract; requires migration of any pending approvals in flight (none exist today, but precedent matters); larger blast radius.

#### Q-pay-3: Return shape (LOCKED — audit-trail return paralleling Decision 5)

**Decision:** `reconcilePayment` returns a `ReconcilePaymentResult` interface with the audit-trail fields the caller needs:

```ts
interface ReconcilePaymentResult {
  platform: "quickbooks" | "xero";
  paymentId: string;        // platform-assigned Payment ID (from the QBO/Xero create response)
  invoiceId: string;
  amount: number;           // cents (echoed for caller convenience)
  customerId?: string;      // populated only when platform === "quickbooks"
  accountId?: string;       // populated only when platform === "xero"
  paymentDate: string;      // resolved date (server-default for QBO if caller omitted)
}
```

**Rationale:**
- Matches Decision 5's `UpdateTransactionCategoryResult` audit-trail pattern exactly
- Honors the codebase convention: 17+ functions in services/accounting/index.ts capture qboRequest/xeroRequest return values with typed shapes
- Returns the platform-assigned `paymentId`, which is currently lost (the existing void return discards it from the QBO/Xero create response)
- Caller (route handler) uses the result to construct the 200 success response body and the activity_log entry

**Rejected:**
- Keep `Promise<void>`. Cons: continues to discard `paymentId`; deviates from in-file convention; route handler can't construct an audit-trail-complete response without querying upstream again.
- Minimal shape `{platform, paymentId}` only. Cons: route handler needs to track and echo `invoiceId`/`amount` separately; fragmented data flow.

#### Q-pay-4: Threshold check location — settled by existing payload (NOT a new decision)

Already constrained by the existing `PaymentThresholdExceededPayload`: the payload includes `thresholdAmount` + `expectedRange`, both populated by the threshold-check logic. Whichever code produces these values is doing the check. That code is the route handler (the only place that creates an approval row with this payload). Service stays threshold-unaware. No decision needed — the payload already settled this.

#### Q-pay-5: Approval-replay path — follows from Q-pay-1

Per ADR-003 Q2: `executeApprovedAccountingWrite` replays the original request from the payload alone. With Q-pay-1 locked (service infers platform from connection), replay calls `reconcilePayment(db, payload.companyId, payload.contactId, payload.invoiceId, payload.amount, payload.entityRef, payload.paymentDate)` — no platform needed in the payload, no platform parameter on the service. The payload's `entityRef` is passed through the same translation logic the route uses (resolve platform, then split into `customerId` or `accountId`).

This means a shared helper between the route handler and the approval-replay path is sensible: `resolveEntityRefByPlatform(db, companyId, contactId, entityRef): Promise<{customerId?: string; accountId?: string}>`. This helper performs the connection lookup AND the split, so both call sites (route + replay) use identical logic.

**Locked service signature:**

```ts
async function reconcilePayment(
  db: Db,
  companyId: string,
  contactId: string | null,
  invoiceId: string,
  amount: number,                                          // cents
  ref: { customerId?: string; accountId?: string },        // exactly one required
  paymentDate?: string,                                    // ISO date; defaults today
): Promise<ReconcilePaymentResult>
```

Throws a typed error if neither `customerId` nor `accountId` is supplied, or if the supplied ref doesn't match the resolved platform.

**Locked endpoint contract:**

```
POST /api/accounting/v1/payments
Body: { companyId, contactId, invoiceId, amount (cents), entityRef, paymentDate?, reason? }
Headers: idempotency-key? (optional)

Responses:
  200 OK { status: "success", data: ReconcilePaymentResult, meta: {...} }
  202 Accepted { status: "pending_approval", data: { approvalId, approvalType, reason }, meta: {...} }
                — when amount > applicable threshold; approval row created with type "accounting.payment.threshold_exceeded"
  400 Bad Request — validation errors (missing required fields, invalid entityRef format, etc.)

Idempotency: full ADR-003 Q5 compliance via withIdempotency wrapper (same pattern as Piece C).
FK separation: requestedByUserId for board actors, requestedByAgentId for agent actors (Piece C pattern).
```

**Wiring scope summary:**

This decision unlocks four pieces of work that mirror Pieces A/B/C from Decision 5:

1. **Piece D (Service refactor)** — Refactor `reconcilePayment` + `applyPaymentToInvoice` (both QBO and Xero) to the locked signature/return shape. Internally: capture qboRequest/xeroRequest return values, extract platform-assigned payment ID, return ReconcilePaymentResult. Threshold check NOT added at service layer (settled by Q-pay-4).
2. **Piece E (Approval-replay wiring)** — Replace the Phase 4c.4 stub for `accounting.payment.threshold_exceeded` in `executeApprovedAccountingWrite`. Replay path uses the same `resolveEntityRefByPlatform` helper the route uses. Three execution outcomes (parallel to Piece B): success → write_executed; missing data → write_failed_replay; unknown errors propagate.
3. **Piece F (Threshold helper + shared resolver)** — Add `resolveEntityRefByPlatform` (shared between route and replay) and integrate the existing `isThresholdExceeded` from Phase 4c.2 into the route handler logic.
4. **Piece G (Route)** — POST /api/accounting/v1/payments. URL+body validation; assertCompanyAccess; withIdempotency wrap; threshold check determines 200-vs-202 path; success → reconcilePayment + 200; threshold exceeded → approval creation + 202; FK-safe actor separation. Tests covering all paths.

**Estimated effort:** ~3-4 hours total across the four pieces. Higher than the WIP doc's original "2-3 hours" estimate because the Pre-Decision-6 verification surfaced more scope (threshold integration + approval-replay wiring) than the original gesture suggested.

**Tenet #16 lock notice:** This decision is now LOCKED. Implementation may extend (add optional parameters, helper functions) but must not change the locked service signature, return shape, payload contract, or endpoint response paths without an explicit REVISED note. Sub-decisions discovered during implementation (parallel to Decision 5's Q2-α-i) should be documented in their respective commit messages and closed in the doc closeout.

**Decision 6 COMPLETE (2026-05-27 end-of-Session-4):**

All 4 pieces of the Decision 6 arc are now shipped end-to-end. Implementation arc spanned 5 commits in a single session:

| Commit       | What shipped                                                                                          |
|--------------|-------------------------------------------------------------------------------------------------------|
| `0924fb94`   | docs(wip,phase-4c-5): LOCK Decision 6 — POST /payments scope (Q-pay-1 + Q-pay-2 + Q-pay-3)            |
| `37c55a08`   | Piece D: Service refactor — ReconcilePaymentResult + PaymentReferenceError + split-ref + platform inference |
| `0d419021`   | Piece F: Shared helpers — resolveEntityRefByPlatform + evaluatePaymentThreshold                        |
| `46f60b53`   | Piece E: Approval-replay wiring — PAYMENT_THRESHOLD_EXCEEDED stub replaced with real reconcilePayment   |
| `41376751`   | Piece G: POST /api/accounting/v1/payments route (FEATURE-COMPLETE)                                     |

**Sub-decisions locked DURING implementation (parallel to Decision 5's Q2-α-i pattern):**

- **Q-pay-F-i (LOCKED during Piece F):** Both helpers (`resolveEntityRefByPlatform` + `evaluatePaymentThreshold`) live in a SINGLE new file `payments-helpers.ts`. Rejected: splitting into two files; extending the existing `thresholds.ts`; placing the resolver in `index.ts`. Reasoning: both helpers are payment-specific concerns, single file is more discoverable, keeps `thresholds.ts` generic and `index.ts` from growing.

- **Q-pay-F-ii (LOCKED during Piece F):** v1 ships WITHOUT `expectedRange` in the `PaymentThresholdExceededPayload`. The optional field stays in the locked payload contract for future invoice-balance-comparison work, but `evaluatePaymentThreshold` returns only `thresholdAmount` and the route handler creates approval rows with `expectedRange: undefined`. Rejected: implementing invoice-balance comparison in Piece F (over-scoped); removing `expectedRange` from the payload via REVISED note (loses future option). Reasoning: optional field, contract permits omitting; invoice-balance comparison would double upstream latency per payment request; threshold check alone is sufficient for v1 Trust Tenet #14 compliance.

**Test trajectory across Decision 6 arc:** 281 (post-Piece-D baseline) → 297 (Piece F) → 301 (Piece E) → 308 (Piece G). +27 tests across the implementation arc.

**End-to-end paths now operational:**

1. **Direct programmatic caller:** `reconcilePayment(db, companyId, contactId, invoiceId, amount, ref, paymentDate?)` from `services/accounting/index.ts`. Single canonical service-layer entry point.
2. **HTTP endpoint:** `POST /api/accounting/v1/payments` with full ADR-003 Q4 + Q5 compliance (202 pending-approval shape + idempotency replay support). Three response paths: 200 success / 202 approval / 400 validation.
3. **Approval-replay path:** Approved `accounting.payment.threshold_exceeded` rows trigger `reconcilePayment` via `resolveEntityRefByPlatform` (the Piece F helper used by BOTH the route and the replay path — single source of truth for the entityRef-to-split-ref translation).

**Pre-implementation scope correction worth keeping:** The WIP doc's original "POST /payments re-implementation: 2-3 hours (once thresholds + service signature fixes done)" was under-specified. Tenet-#7-driven verification of 6 assumptions about the existing infrastructure surfaced the true scope (zero callers on the existing dispatcher; no threshold integration; no idempotency wiring; void return deviating from 17+ in-file conventions; overloaded entityRef parameter). The verified findings informed Decision 6's lock. Final actual implementation: ~3-4 hours across 5 commits. The pattern "verify before estimating" prevented hours of unscoped work.

**Decision 6 unblocks Phase 4c.5 endpoint roadmap:** POST /payments is the second fully-functional Phase 4c.5 write endpoint after POST /transactions/:txnId/category (Piece C). POST /invoices remains the third — architecturally unblocked from Q1 + Q2 prerequisites (both implemented), but still requires its own design work (request body schema, setup-fee-vs-recurring discriminator, etc.). The two remaining `executeApprovedAccountingWrite` stubs (`accounting.invoice.dedupe_ambiguous` + `accounting.invoice.pricing_mismatch`) await the Invoice endpoint design.

### Decision 7: POST /invoices scope (DESIGN LOCK — 2026-05-28 Session 5)

The third and final Phase 4c.5 write endpoint. Creates a monthly service invoice in **Ledgerix Pro's own QBO** (not client books). Used exclusively by the Billing & Invoicing agent. This is the highest-risk write endpoint in Phase 4c.5: it creates a new financial record (vs. mutating one), and it sits behind **two** safety gates (dedupe + pricing), not one. Per the Trust Tenet, the EA §2B.4 v1.0 language ("Service tier doesn't match expected pricing: No automatic validation. The billing agent is responsible.") is **superseded** — endpoint-enforced pricing validation replaces agent-trust. An EA REVISED note records this.

Decision 7 follows the Decision 6 shape: lock the contract first, implement as discrete Pieces, share a single helper between the route handler and the approval-replay path.

#### Pre-implementation findings (Tenet #7 verification — 2026-05-28)

All confirmed against code before locking:

1. **`findOrCreateCustomer` already performs dedupe detection.** It returns a 5-value `action` discriminant: `found_by_email` / `found_by_name_exact` / `created_new` (all auto-proceed) and `ambiguous_name_only` / `ambiguous_email_match_different_name` (both HITL-required), the latter two carrying a `matchDetails` object (submittedName/submittedEmail/storedName/storedEmail). The route does NOT reimplement dedupe — it reads `action` and gates on the two ambiguous values. Signature: `findOrCreateCustomer(db, companyId, contactId, name, email)`.
2. **`createInvoice` takes `lineItems: Array<{description, amount}>` and `dueDate` directly; it computes its own total and resolves the QBO Item ref internally.** It has NO `serviceTier` or pricing parameter. Therefore pricing validation MUST happen in the route, BEFORE the `createInvoice` call. Signature: `createInvoice(db, companyId, contactId, customerRef, lineItems, dueDate)`.
3. **Two distinct contactId semantics exist.** `findOrCreateCustomer` and `createInvoice` take `contactId: string | null` as the **QBO books-connection key** — and per EA §2B.4 this is `null` for Ledgerix Pro's own-QBO global-connection pattern. But `charter.ts` (`isCharterForInvoicing(db, companyId, ghlContactId)`) and the pricing lookup key on the **GHL contactId** identifying *which client to bill*. These are different identifiers. The payload's `BaseAccountingPayload.contactId` (required `string`) is the **GHL contactId**; the QBO write calls pass `contactId: null`. This is the central seam of the design (parallel to Decision 6's Q-pay-2 overloaded-entityRef split).
4. **The two approval payloads are already locked (Phase 4c.4, committed).** `InvoiceDedupeAmbiguousPayload` and `InvoicePricingMismatchPayload` are fully specified with `dedupeDecision` / `pricingDecision` sub-objects. Decision 7 wires to them — it does not redefine them. Any change to the payloads would require an ADR-003 Amendment.
5. **`getExpectedPriceCents` and `getSetupFeeCents` exist (Q1/Q2 implemented).** `getExpectedPriceCents(...)` returns the recurring expected price keyed by tier + isCharter; `getSetupFeeCents(...)` returns the one-time setup fee keyed by tier (no isCharter dimension per Q2). `isCharterForInvoicing` defaults to `false` for any client without a charter row (charter.ts header line 67).

#### Existing payload contracts (Phase 4c.4) — the constraints Decision 7 honors

```ts
interface BaseAccountingPayload {
  companyId: string;
  contactId: string;        // GHL contactId — the client being billed (NOT the QBO books key)
  reason?: string;
  idempotencyKey?: string;
}

interface InvoiceDedupeAmbiguousPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/invoices";
  customerName: string;
  customerEmail: string;
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up";
  billingPeriod: { start: string; end: string };
  lineItems: Array<{ description: string; amount: number }>;
  dueDate?: string;
  dedupeDecision: {
    matchedCustomerId: string;
    matchType: "name_only" | "email_only_different_name";
    confidence: number;
  };
}

interface InvoicePricingMismatchPayload extends BaseAccountingPayload {
  requestType: "POST /api/accounting/v1/invoices";
  customerName: string;
  customerEmail: string;
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up";
  billingPeriod: { start: string; end: string };
  lineItems: Array<{ description: string; amount: number }>;
  dueDate?: string;
  pricingDecision: {
    sentAmountCents: number;
    expectedAmountCents: number;
    isCharter: boolean;
    deltaCents: number;
    deltaPercent: number;
  };
}
```

Both payloads omit a `billingMode` field. The design must therefore carry the recurring-vs-setup distinction WITHOUT amending the payload — see Q-inv-1.

---

#### Q-inv-1: Recurring-vs-setup discriminator (LOCKED — explicit `billingMode` in request body; payload-derivable from serviceTier+amount, not stored)

**Decision:** The request body carries an explicit discriminator `billingMode: "recurring" | "setup"` (required). The route uses it to choose which pricing function to validate against:
- `billingMode: "recurring"` → expected = `getExpectedPriceCents(tier, isCharter)`, where `isCharter = await isCharterForInvoicing(db, companyId, ghlContactId)`.
- `billingMode: "setup"` → expected = `getSetupFeeCents(tier)`. The `isCharter` lookup is SKIPPED (setup fees don't vary by charter per Q2); `pricingDecision.isCharter` is recorded as `false` for audit consistency.

The locked approval payloads have NO `billingMode` field and will NOT be amended. To keep replay deterministic, storing `billingMode` inside the existing free-text `reason` field is REJECTED (fragile parsing). Instead — see sub-decision Q-inv-1-α.

**Sub-decision Q-inv-1-α (LOCKED):** Because the payload cannot carry `billingMode` and replay must be deterministic, the dedupe and pricing approval paths only ever need to RE-CREATE the invoice (not re-validate pricing — the human already approved the amount by approving the row). Therefore replay does NOT need `billingMode`: it calls `findOrCreateCustomer` + `createInvoice` directly with the payload's `lineItems`/`dueDate`, bypassing the pricing gate entirely (the approval IS the human override of that gate). `billingMode` is a route-time-only concern. This eliminates the need to persist it. Confirmed consistent with ADR-003 Q2 ("re-executable from the payload alone") — the executable unit is the invoice creation, not the validation.

**Rationale:** Explicit beats inferred at the API boundary (the agent knows whether it's billing monthly service or onboarding setup; making it state that is clearer than inferring from amount). Skipping the charter lookup for setup mode avoids a needless DB read and reflects Q2's business semantics. Keeping `billingMode` out of the payload respects the locked Phase 4c.4 contract and the trust-tenet principle that an approved row is a human override — replay re-creates, it does not re-judge.

**Rejected:**
- Infer mode from amount alone (no body field). Cons: ambiguous when setup and recurring prices coincide; hides intent.
- Add `billingMode` to both payloads via ADR-003 Amendment. Cons: larger blast radius; unnecessary once Q-inv-1-α establishes replay doesn't need it.
- Two separate endpoints (`/invoices/recurring` + `/invoices/setup`). Cons: same rejection as Q2 Option C — setup fees ARE invoices structurally; doubles API/test/doc surface.

#### Q-inv-2: Dedupe gate seam (LOCKED — route reads `findOrCreateCustomer.action`; shared resolver between route and replay)

**Decision:** The route calls `findOrCreateCustomer(db, companyId, /* QBO books key */ null, customerName, customerEmail)`. It branches on `action`:
- `found_by_email` / `found_by_name_exact` / `created_new` → proceed to pricing gate (Q-inv-3) using the returned `customerId`.
- `ambiguous_name_only` → create approval `accounting.invoice.dedupe_ambiguous` with `dedupeDecision.matchType: "name_only"`.
- `ambiguous_email_match_different_name` → create approval with `dedupeDecision.matchType: "email_only_different_name"`.

The `matchType` enum values in the payload (`name_only` / `email_only_different_name`) map directly from the two `action` values. `matchedCustomerId` = the `customerId` the function returned (it returns the matched id even in ambiguous cases). The dedupe gate runs BEFORE the pricing gate — a customer we can't unambiguously resolve is escalated before we reason about price.

**Sub-decision Q-inv-2-α (LOCKED — `confidence` value):** `findOrCreateCustomer` does NOT compute a numeric confidence score. Rather than invent a scorer, `confidence` is a FIXED value derived from `matchType`: `email_only_different_name` → `0.5`; `name_only` → `0.3`. Reasoning: an email match with a name conflict is a stronger signal of "same entity, data drift" than a bare name match with an email conflict, so it gets the higher value. These are documented as heuristic placeholders, honest about being non-computed. If a real scorer is later added to `findOrCreateCustomer`, the route passes it through instead — interface-compatible extension, no payload change.

**Sub-decision Q-inv-2-β (LOCKED — replay path):** On approval of a `dedupe_ambiguous` row, the human has decided the matched customer IS correct. Replay calls `createInvoice(db, companyId, null, dedupeDecision.matchedCustomerId, lineItems, dueDate ?? <Net-15 default>)` directly — it does NOT re-run `findOrCreateCustomer` (that would just re-detect the ambiguity). The approval encodes the resolution: use `matchedCustomerId`.

**Rationale:** Reuses existing, tested dedupe detection rather than duplicating it. The match-type mapping is 1:1 and total. Running dedupe before pricing means the cheaper/safer escalation happens first. Replay-uses-matchedCustomerId is the literal meaning of approving the row.

**Rejected:**
- Route reimplements its own dedupe query. Cons: duplicates `findOrCreateCustomer`; two code paths drift.
- Replay re-runs `findOrCreateCustomer`. Cons: re-detects the same ambiguity, creating an approval loop.

#### Q-inv-3: Pricing gate seam (LOCKED — route compares line-item total to expected; tolerance + mismatch payload)

**Decision:** After the dedupe gate resolves to a concrete `customerId`, the route computes `sentAmountCents = sum(lineItems[].amount)` (converted to cents) and compares against `expectedAmountCents` (from Q-inv-1's mode-appropriate pricing function). A new shared helper `evaluateInvoicePricing` (parallel to Decision 6's `evaluatePaymentThreshold`) returns whether the amounts match within tolerance plus the audit fields.
- **Match (within tolerance)** → proceed to `createInvoice`; return 201.
- **Mismatch (outside tolerance)** → create approval `accounting.invoice.pricing_mismatch` with the full `pricingDecision` sub-object (`sentAmountCents`, `expectedAmountCents`, `isCharter`, `deltaCents`, `deltaPercent`); return 202.

**Sub-decision Q-inv-3-α (LOCKED — tolerance):** Tolerance is **exact match (zero tolerance), in cents**. Any non-zero `deltaCents` escalates. Reasoning: this is Ledgerix Pro billing its OWN clients a KNOWN price from our OWN pricing tables — there is no rounding or FX ambiguity to absorb. The Trust Tenet favors the conservative path; a $1 discrepancy on our own invoice is worth a human glance. `deltaPercent` is still recorded for the approver's context but is not part of the gate condition.

**Sub-decision Q-inv-3-β (LOCKED — replay path; REVISED 2026-05-28 Session 5):** On approval of a `pricing_mismatch` row, the human has accepted the sent amount. Replay calls `createInvoice` with the payload's `lineItems` (the sent amounts) directly, bypassing the pricing comparison. The approval IS the override (per Q-inv-1-α).

**REVISED 2026-05-28 (Tenet #16 explicit revision):** Piece I implementation surfaced that the original phrasing assumed replay had a "resolved customerId" to pass to `createInvoice` — but `InvoicePricingMismatchPayload` carries only `customerName` + `customerEmail`, NOT a resolved `matchedCustomerId` (unlike `InvoiceDedupeAmbiguousPayload`, which does). The payload was locked in Phase 4c.4 and is not amended. Resolution chosen: **Option A — pricing_mismatch replay re-resolves the customer via `qbo.findOrCreateCustomer(db, companyId, null, payload.customerName, payload.customerEmail)` before calling `createInvoice`.** This honors the locked Phase 4c.4 contract (no ADR-003 Amendment), satisfies ADR-003 Q2 self-sufficiency (name+email is sufficient input to re-resolve), and keeps the conservative Trust-Tenet path for the rare drift case (below). Option B (amend the payload to add `customerId`) was rejected: it amends a locked contract to save one API call on a rare path — the locked-decisions-stay-locked tenet weighs against reopening a contract three other paths depend on for a marginal optimization.

**Ambiguous-on-replay edge case (locked behavior):** When pricing_mismatch replay re-runs `findOrCreateCustomer`, the `action` result is handled as: the three unambiguous values (`found_by_email` / `found_by_name_exact` / `created_new`) → proceed to `createInvoice` with the returned `customerId`; the two ambiguous values (`ambiguous_name_only` / `ambiguous_email_match_different_name`) → the customer-dedupe state drifted between original approval and replay; the human's pricing approval does NOT authorize resolving a fresh dedupe ambiguity → return `write_failed_replay` with a message explaining the state drift (manual intervention: re-submit, which triggers the dedupe gate fresh). This is the conservative path: escalate, don't auto-resolve a new ambiguity off a stale approval.

**Documented asymmetry (intentional):** The two invoice replay paths differ by design, reflecting their different payload shapes. `dedupe_ambiguous` replay uses the stored `dedupeDecision.matchedCustomerId` (Q-inv-2-β) and does NOT re-resolve. `pricing_mismatch` replay re-resolves via `findOrCreateCustomer` (this note). The asymmetry is correct, not a smell — the dedupe payload persisted the resolution because dedupe IS what resolved it; the pricing payload never had a resolved id to persist.

**Sub-decision Q-inv-3-γ (LOCKED — helper location):** `evaluateInvoicePricing` + the customer-resolution wrapper live in a new file `invoices-helpers.ts` (parallel to `payments-helpers.ts`), NOT in `index.ts` or `pricing.ts`. Keeps `pricing.ts` as the canonical price-lookup module and `index.ts` from growing. The shared helper is used by BOTH the route and (for the pricing fields) the replay audit path.

**Rationale:** Pricing comparison cannot live in `createInvoice` (Finding 2 — it has no pricing param), so the route is the only correct place. Zero-tolerance is defensible precisely because we own both sides of the number. Mirroring `payments-helpers.ts` keeps the codebase symmetric.

**Rejected:**
- Percentage tolerance (e.g., ±2%). Cons: invents slack where none is warranted on our own known prices.
- Validate pricing inside `createInvoice`. Cons: would require changing a tested service signature and conflates record-creation with policy.

---

#### Locked endpoint contract

```
POST /api/accounting/v1/invoices
Query:   companyId (always Ledgerix Pro's UUID), contactId (GHL contactId of client to bill)
Headers: idempotency-key? (optional; ADR-003 Q5 via withIdempotency)
Body: {
  customerName: string,
  customerEmail: string,
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up",
  billingMode: "recurring" | "setup",            // Q-inv-1 discriminator
  billingPeriod: { start: string; end: string }, // ISO dates
  lineItems: Array<{ description: string; amount: number }>,
  dueDate?: string,                              // ISO date; defaults Net-15
  reason?: string
}

Responses:
  201 Created      { status: "success", data: { invoiceId, invoiceNumber, customerId, totalAmount, dueDate, status }, meta }
  202 Accepted     { status: "pending_approval", data: { approvalId, approvalType, reason }, meta }
                     — approvalType is accounting.invoice.dedupe_ambiguous (Q-inv-2) OR accounting.invoice.pricing_mismatch (Q-inv-3)
  400 Bad Request  — validation errors (missing/invalid body fields, unknown serviceTier, empty lineItems, future-or-invalid dueDate)

Identifier seam (Finding 3):
  - GHL contactId  → pricing + charter lookups + payload.contactId + audit actor context
  - QBO books key  → ALWAYS null in findOrCreateCustomer/createInvoice calls (Ledgerix Pro own-QBO global connection)

Gate order: validate body → dedupe gate (Q-inv-2) → pricing gate (Q-inv-3) → createInvoice → 201.
FK separation: requestedByUserId for board actors, requestedByAgentId for agent actors (Piece C/G pattern).
```

#### Wiring scope — four Pieces (parallel to Decision 6's D/E/F/G)

1. **Piece H (Helpers)** — New `invoices-helpers.ts`: `evaluateInvoicePricing(sentAmountCents, expectedAmountCents)` → `{ matches: boolean; deltaCents; deltaPercent }` (zero-tolerance per Q-inv-3-α); plus a small `confidenceForMatchType(matchType)` mapper (Q-inv-2-α). Unit tests for match/mismatch/delta math + the two confidence values.
2. **Piece I (Approval-replay wiring)** — Replace the two Phase 4c.4 stubs in `executeApprovedAccountingWrite`: `accounting.invoice.dedupe_ambiguous` → `createInvoice(..., matchedCustomerId, ...)` (Q-inv-2-β); `accounting.invoice.pricing_mismatch` → `createInvoice(..., resolved customerId, ...)` (Q-inv-3-β). Both pass QBO key `null`. Outcomes parallel to Pieces B/E: success → `write_executed`; upstream failure → `write_failed_replay`; unknown → propagate. This brings the dispatcher to 4-of-4 wired.
3. **Piece J (no service refactor needed)** — Unlike Decision 6's Piece D, `findOrCreateCustomer` and `createInvoice` already have correct signatures and return shapes (Finding 1+2). Piece J is therefore a NO-OP placeholder kept for numbering symmetry; any minor adjustment (e.g., surfacing `customerId` from the create path in the success envelope) is folded into Piece K. **Flag:** confirm at implementation time that no signature change sneaks in — if one does, it gets its own commit, not a silent fold.
4. **Piece K (Route)** — `POST /api/accounting/v1/invoices`: body validation, `assertCompanyAccess`, `withIdempotency` wrapping, dedupe gate → pricing gate → `createInvoice`, three response paths (201 / 202×2 / 400), FK actor separation, GHL-vs-null contactId seam.

#### Out of scope for Decision 7 (deferred)

- **Onboarding/cancellation workflow wiring of charter status** (already tracked under Q1's "What is NOT implemented yet"). The Invoice endpoint READS charter status via `isCharterForInvoicing`; it does not write it.
- **Production seed of `setup_fee_pricing`** (tracked under Q2). The endpoint will return `SetupFeeNotFoundError` → 400/500 until prod is seeded; that's an operational step, not Decision 7 code.
- **A computed customer-match confidence scorer** — Q-inv-2-α uses fixed heuristic values; a real scorer is a future enhancement.
- **Multi-tier / proration / partial-period invoices** — single tier, single billing period per call for v1.

#### EA REVISED note required

EA §2B.4 (API Spec v1.0) states pricing gets "no automatic validation — the billing agent is responsible." Decision 7 supersedes this with endpoint-enforced zero-tolerance pricing validation + dedupe escalation. A REVISED note (Tenet #16) records the supersession when Decision 7 ships.

#### Estimated effort

~3-4 hours across Pieces H/I/K (J is a no-op). Less than Decision 6 because the service layer needs no refactor (Finding 1+2) and the dedupe detection already exists. Test trajectory target: 308 → ~330 (+~22: helper math, 2 confidence values, 2 replay paths × outcomes, route happy-path + both 202 gates + 400 validation + FK separation).

#### Decision 7 closes Phase 4c.5's endpoint roadmap

POST /invoices is the third and final write endpoint. On ship: 8-of-8 Phase 4 endpoints production-ready; 4-of-4 `executeApprovedAccountingWrite` stubs wired. Phase 4c.5 becomes ready_to_merge_to_adr (pending Q5 multi-line journal semantics, which gates no endpoint).

## Architecture Decisions Pending

### ~~Q1: Charter status storage mechanism (ADR-003 Amendment 1 Gap 1)~~ — LOCKED + IMPLEMENTED 2026-05-27 Session 4 (Option B)

**Decision: Option B — Local DB table `client_charter_status`.**

**Rationale (Trust Tenet #14 invoked):** Billing is the primary client-funds touchpoint. Q1's choice directly determines whether a client gets billed the right amount. Three considerations drove the lock:

1. **Source of truth in our own DB.** When a billing question arises ("why was I charged $599 instead of $399?"), the answer is auditable in our own data. Options A (GHL) and C (computed) both push the answer to external/derived state.

2. **Structurally enforces the cancellation rule.** EA Section 7.1 documents that Charter is "lost permanently on cancellation" and "not transferable, sellable, or recoverable." Option B's status enum (`active` | `cancelled_was_charter` | `never_charter`) makes "you cancelled, you forfeited Charter" a database fact. Option A requires us to *remember not to* re-flip the GHL field; Option C is fundamentally incapable of modeling it (would compute a cancelled-and-returned client as Charter from `created_at`).

3. **No new runtime dependency for billing.** Option A puts GHL on the critical path for every invoice. If GHL is down, we can't bill. This conflicts with the existing Option B credential-isolation TODO and reproduces the kind of coupling that caused the May 11-17 hallucinated email incident.

Options A and C rejected:
- **Option A (GHL custom field):** Runtime dependency on GHL for invoicing; no captured history; "cancelled-and-returned" rule must be enforced procedurally rather than structurally; conflicts with credential-isolation roadmap.
- **Option C (compute from created_at + cutoff):** Cannot model "cancelled-and-returned forfeits Charter" — a returning client's `created_at` is still before the cutoff, so the computed flag would incorrectly grant Charter. Either timestamp or count variant requires picking a dimension the business rule doesn't actually express.

**Implementation shape (locked contract):**

New table `client_charter_status`:

| Column           | Type      | Notes                                                                |
|------------------|-----------|----------------------------------------------------------------------|
| id               | uuid PK   |                                                                      |
| companyId        | text FK   | → companies.id                                                       |
| contactId        | text      | GHL contact ID                                                       |
| grantedAt        | timestamp | When charter was first granted (or null if `status === never_charter`) |
| status           | enum      | `active` / `cancelled_was_charter` / `never_charter`                 |
| statusChangedAt  | timestamp | Last status transition                                               |
| cancelledAt      | timestamp | Set when status moves to `cancelled_was_charter` (else null)         |
| reason           | text      | Free-text reason for status (optional)                               |
| createdAt        | timestamp |                                                                      |
| updatedAt        | timestamp |                                                                      |

Unique constraint on `(companyId, contactId)` — one row per client per company.

Service functions in `server/src/services/accounting/charter.ts`:

- `getCharterStatus(db, companyId, contactId): Promise<"active" | "cancelled_was_charter" | "never_charter">` — returns the current status. Throws if no row exists for the client (or returns `"never_charter"` as a default; lock this in implementation when designing the function — likely default-to-never_charter so callers don't need to seed every client).
- `isCharterForInvoicing(db, companyId, contactId): Promise<boolean>` — helper returning `true` only when `status === "active"`. This is the function the Invoice endpoint will call to populate `isCharter` for `getExpectedPriceCents`.

State-transition rules (locked):

- New client onboarding: write row with `status = "active"` if among first 10 paying clients; `status = "never_charter"` otherwise. `grantedAt = now` for active; `null` for never.
- Cancellation: transition `active → cancelled_was_charter`. Set `cancelledAt = now`, `statusChangedAt = now`. Once in `cancelled_was_charter`, NO transition back to `active` is permitted — locked structurally (service-layer enforcement; future returning-client onboarding writes a new row with `status = never_charter`).
- `never_charter → active` is NOT permitted (Charter window closes at client 10; can't grant retroactively).

**Estimated effort:** ~2-3 hours total. ACTUAL: shipped 2026-05-27 commit `5b4856bb` — schema + service + 20 tests in a single commit. New migration `0068_youthful_blockbuster.sql`. Service module at `server/src/services/accounting/charter.ts`. Test baseline 233 → 253 (+20).

**Tenet #7 correction caught during implementation:** Pre-implementation reads of `service_tier_pricing.ts` and `client_pricing_overrides.ts` surfaced that the tier-value convention in this codebase is display-style ("Foundation" / "Growth Engine" / "Scale-Up"), NOT snake_case. Q1 doesn't actually use tier values (charter is per-client, not per-tier), so this doesn't affect Q1's implementation — but it was a real verification that prevented Q2 from inheriting the lock doc's incorrect snake_case assumption.

**What is NOT implemented yet** (deferred to follow-up sessions):
- Onboarding workflow integration — the call site that determines `grantCharterToNewClient` vs `recordNonCharterClient` based on the "first 10 paying clients" check
- Cancellation workflow integration — the call site that invokes `cancelCharter` when a client cancels
- Invoice endpoint wiring — POST /invoices (next Phase 4c.5 endpoint) will call `isCharterForInvoicing`

**Decision 5 reference (Tenet #16):** This decision is now LOCKED. Implementation may extend (add optional columns, helper functions) but must not change the locked schema/enum/state-transition contract without an explicit REVISED note.

### ~~Q2: Setup fee handling (ADR-003 Amendment 1 Gap 2)~~ — LOCKED + IMPLEMENTED 2026-05-27 Session 4 (Option B)

**Decision: Option B — Parallel `setup_fee_pricing` table.**

**Rationale:** Setup fees and monthly recurring pricing have structurally different business semantics. Setup fees don't vary by Charter status (EA Section 7: "All clients (including Charter) pay a one-time setup fee at onboarding"); recurring pricing does. Five considerations drove the lock:

1. **Schema semantics match business semantics.** Setup fees don't have `isCharter` semantics — putting them in `service_tier_pricing` (which has `isCharter` as a key dimension) makes that column meaningless on setup_fee rows. Option B's separate table reflects the truth.

2. **Aligns with Q1's lock.** Q1 went toward separate, structurally-correct modeling (its own `client_charter_status` table) rather than overloading existing schema. Q2 Option B follows the same principle — separate business concerns get separate tables.

3. **Future-proofs without over-engineering.** If setup fees later grow refund logic, partial fees, or proration, Option B can extend without disturbing recurring pricing. Option A would require either schema-wide changes or implicit-rule discriminators.

4. **The cost is small.** One extra table + one extra service function + one extra seed step. The existing patterns (`getExpectedPriceCents`, admin seed endpoint, tests) are already in place — `getSetupFeeCents` is a near-clone with simpler signature.

5. **Maintains codebase symmetry.** `service_tier_pricing` is for monthly recurring; `setup_fee_pricing` is for one-time setup; `client_pricing_overrides` is for per-client overrides; `client_charter_status` (Q1) is for charter lifecycle. Each table has one clear responsibility.

Options A and C rejected:
- **Option A (extend service_tier_pricing with pricing_type):** Forces `isCharter` to be a meaningless column on setup_fee rows; schema doesn't reflect business; row meaning becomes dependent on an implicit discriminator; future divergence is awkward.
- **Option C (separate endpoint):** Premature separation; setup fees ARE invoices structurally; two endpoints when one parameterized endpoint may suffice; more API surface = more attack surface, docs, tests.

**Implementation shape (locked contract):**

New table `setup_fee_pricing`:

| Column         | Type      | Notes                                                            |
|----------------|-----------|------------------------------------------------------------------|
| id             | uuid PK   |                                                                  |
| tier           | text      | "Foundation" / "Growth Engine" / "Scale-Up" (matching service_tier_pricing convention) — **CORRECTED 2026-05-27 during Q1 implementation:** the original lock doc text said snake_case; Tenet #7 verification of `service_tier_pricing.ts` surfaced that the actual convention is display-style |
| amountCents    | integer   | $249 / $349 / $1,200 = 24900 / 34900 / 120000                    |
| effectiveFrom  | timestamp | Effective-dated, paralleling service_tier_pricing                |
| effectiveTo    | timestamp | null = currently active                                          |
| createdAt      | timestamp |                                                                  |
| updatedAt      | timestamp |                                                                  |

Notes:
- NO `isCharter` column (setup fees don't vary by Charter)
- NO `contactId` column (no per-client setup fee overrides for now; locked — if future business need surfaces, add via REVISED note)
- Effective-dating supports future fee changes without rewriting history

Service function in `server/src/services/accounting/pricing.ts` (parallel to existing `getExpectedPriceCents`):

- `getSetupFeeCents(db, tier): Promise<{ amountCents: number; priceRecordId: string }>` — looks up the currently-active setup fee row for the tier. Throws `SetupFeeNotFoundError` if no active row exists for the tier.

**Seed values (locked from EA Section 7):**

| Tier            | Amount Cents | Display |
|-----------------|--------------|---------|
| Foundation      | 24900        | $249    |
| Growth Engine   | 34900        | $349    |
| Scale-Up        | 120000       | $1,200  |

Admin seed endpoint `POST /api/admin/pricing/seed` extended to write these 3 rows alongside the existing 6 `service_tier_pricing` rows. Same `inserted: N, skipped: M` response shape; idempotent.

**Estimated effort:** ~2-3 hours total. ACTUAL: shipped 2026-05-27 commit `83b80a72` — schema + migration + service function + admin seed extension + 9 tests in a single commit. New migration `0069_damp_bloodscream.sql`. Service function added to `server/src/services/accounting/pricing.ts` alongside existing `getExpectedPriceCents`. Test baseline 253 → 262 (+9 net new: 6 in pricing.test.ts, 3 net new in admin.test.ts).

**Sub-decision Q2-α-i locked during implementation:** The original Q2 lock specified the admin seed endpoint extension as "Same `{ inserted, skipped }` response shape" but the actual extension required combining two tables' results. Three sub-options surfaced during implementation:

- **Q2-α-i (chosen):** Combined endpoint with per-table sub-objects. Response shape changed from `{ data: { inserted, skipped, ... }, meta }` to `{ data: { pricing: { inserted, ... }, setupFees: { inserted, ... } }, meta }`. Preserves per-table visibility (caller can see EACH table's seed outcome, distinguishing partial success from complete success).
- Q2-α-ii: Combined endpoint with summed totals. Rejected because it loses the visibility distinction between which table succeeded/failed.
- Q2-α-iii: Separate endpoint POST /admin/setup-fees/seed. Rejected because the lock specified extending the existing endpoint.

Q2-α-i is the contract for POST /api/admin/pricing/seed going forward. The change is backward-incompatible for the response body — three existing admin.test.ts tests required updates to read from the new nested `data.pricing.*` and `data.setupFees.*` keys (all updates were correct and expected per the locked sub-decision).

**What is NOT implemented yet** (deferred to follow-up sessions):
- Invoice endpoint wiring — POST /invoices will call `getSetupFeeCents` for setup-fee invoice flows alongside `isCharterForInvoicing` (Q1) + `getExpectedPriceCents` for recurring billing
- Production seed — POST /api/admin/pricing/seed must be invoked on prod after this deploys to populate the 3 new setup_fee_pricing rows. Not done in any of the implementation commits (Tenet #14 — production data changes are operational work, not code commits)

**Decision 5 reference (Tenet #16):** This decision is now LOCKED. Implementation may extend (add optional columns, helper functions) but must not change the locked schema/seed-values/lookup-semantics contract without an explicit REVISED note.

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

### Session 5 — 2026-05-28

**Goal:** Design and lock POST /invoices (the third and final Phase 4c.5 write endpoint) per the lock-then-implement discipline established by Decisions 5 and 6.

**What happened:**
- Re-read CLAUDE.md operating principles + all tracked docs (WIP, PHASE-4-PROGRESS, EA v3.4, Brief v1.4, TODO) at session start. Confirmed EA is v3.4 (a "v3.6" reference was a misremember — verified the uploaded truth docs are byte-identical to the Project copies and the local header reads v3.4).
- Tenet #7 verification BEFORE locking: read write-approvals.ts (the two invoice payloads are already locked from Phase 4c.4), findOrCreateCustomer + createInvoice (service signatures), and the pricing/charter service signatures. Three findings drove the design: (1) findOrCreateCustomer already does dedupe detection via its 5-value action discriminant; (2) createInvoice has no pricing param, so pricing validation must live in the route; (3) two distinct contactId semantics — GHL contactId for pricing/charter/payload/audit vs. QBO books key which is always null for Ledgerix Pro's own QBO.

**What was decided (locked):**
- Decision 7 locked under Option A (one decision, three sub-decisions Q-inv-1/2/3, single commit) — see Architecture Decisions Made.
- Q-inv-1: explicit billingMode discriminator in the request body; payload needs no billingMode field because an approved row is a human override and replay re-creates rather than re-validates (Q-inv-1-α).
- Q-inv-2: dedupe gate reuses findOrCreateCustomer.action; fixed heuristic confidence values 0.5/0.3 (Q-inv-2-α, honestly flagged as non-computed); replay uses matchedCustomerId (Q-inv-2-β).
- Q-inv-3: pricing gate compares line-item total to expected; zero-tolerance exact-cents match (Q-inv-3-α) because Ledgerix Pro owns both sides of the number; helper in new invoices-helpers.ts (Q-inv-3-γ).
- Q-inv-3-β REVISED (Tenet #16): pricing_mismatch replay re-resolves customer via findOrCreateCustomer (Option A) — payload carries no resolved customerId; locked Phase 4c.4 contract not amended; ambiguous-on-replay drift escalates to write_failed_replay (conservative path); intentional asymmetry with dedupe_ambiguous replay documented.

**What's NOT done:** No code. Decision 7 is a DESIGN LOCK only. Implementation is Pieces H/I/J/K (J is a no-op — service layer already correct). EA §2B.4 REVISED note deferred to ship time.

**State at session end:**
- Codebase HEAD: unchanged from session start (fc80911b) plus this docs commit.
- 308 tests passing (no code touched).
- Phase 4c.5: Decisions 4/5/6 feature-complete + shipped; Decision 7 design-locked, implementation pending. 2 of 4 approval stubs wired (the 2 invoice stubs get wired in Piece I).
- Next session: implement Piece H (invoices-helpers.ts + tests).
