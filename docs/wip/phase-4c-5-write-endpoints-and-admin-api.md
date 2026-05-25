# WIP: Phase 4c.5 — Re-ship Write Endpoints Atop Safety Layer + Admin API Foundation

**Status:** in_progress
**Started:** 2026-05-24
**Last updated:** 2026-05-24 end of Sunday (Block 2 deferred — see Session Log)
**Owner:** Scott Hansbury
**Related ADRs:**
- ADR-001 (Pattern B Full API endpoints)
- ADR-002 (Phase 4b write endpoint design — idempotency, audit log, two-phase failure)
- ADR-003 (Phase 4c safety architecture + 3 amendments)
**Estimated remaining work:** Multi-session, likely 20-30 hours total across:
- Admin endpoint scaffolding (auth, routing, base pattern): 2-3 hours
- Bootstrap data via admin endpoints (pricing, thresholds): 1-2 hours
- Charter status storage decision + implementation: 3-5 hours
- Setup fee handling decision + implementation: 3-5 hours
- get-transaction-by-id infrastructure (QBO + Xero, per-type dispatch): 5-7 hours
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

### Q3: get-transaction-by-id infrastructure scope

To return `previousAccountRef` in `POST /transactions/:txnId/category` per spec, the endpoint must fetch the transaction's current account before updating. No `getTransactionById(txnId)` function exists today.

The challenge: QBO has Purchase, Deposit, Invoice, Bill, JournalEntry, Payment, Deposit, BillPayment — each a different API endpoint. Xero has BankTransactions, Invoices, Bills, ManualJournals. The endpoint doesn't know which type a given `txnId` refers to.

Three options:
- **Option A:** Build per-type get-transaction-by-id functions for QBO + Xero (full coverage). 5-7 hours of upstream API work.
- **Option B:** Build only the most common types (Purchase, Deposit for QBO; BankTransactions for Xero). Less coverage; transaction category updates for less-common types create an approval rather than executing.
- **Option C:** Defer get-transaction-by-id entirely. Every category update creates an approval (`accounting.transaction.category_with_unknown_previous`). Forces HITL on every change.

**Rejected from earlier conversation:** Option C would not scale to a 50-client system with many monthly category changes. Rejected by Scott.

**To be resolved in:** Phase 4c.5 session focused on transaction category endpoint. Decision blocks transaction-category endpoint re-implementation.

(Q4 and Q5 resolved this session — see Decisions 2 and 3 above.)

## Work Done (cumulative)

- `e618231b` (Sunday 2026-05-24, Block 1) — activity_log.companyId nullable + compareAndSeed helper + this WIP doc
  - Migration 0067_last_gateway.sql: ALTER TABLE activity_log ALTER COLUMN company_id DROP NOT NULL
  - LogActivityInput type: companyId is now `string | null`
  - publishLiveEvent and PluginEvent emissions skipped when companyId is null (per Option 1)
  - compareAndSeed generic helper in server/src/services/admin/compare-and-seed.ts (no tests yet)
  - WIP doc committed with Decisions 1, 2 (revised), 3 locked

## Next Steps (in order)

### IMMEDIATE — Block 2 (Sunday 2026-05-24 post-break, ~2 hours)

1. **Fix admin.ts compile errors** (uncommitted file at server/src/routes/admin.ts):
   - Change import path `from "../services/admin/compare-and-seed.ts"` to `.js` (ESM convention)
   - Fix `effectiveToField` type errors at lines 75 and 144 — TypeScript narrowing issue. Likely needs explicit type annotation on the field name or a cast in the compareAndSeed call.
   - Verify with `pnpm typecheck` from server directory

2. **Mount admin router in app.ts**:
   - Add `import { adminRoutes } from "./routes/admin.js";` to imports section (~line 26)
   - Add `api.use(adminRoutes(db));` to the route mounting section (~line 210, after other api.use calls)
   - Verify with `pnpm typecheck`

3. **Write tests for admin endpoints** (`server/src/routes/admin.test.ts` — new file):
   - Test successful seed (inserted: N, skipped: 0)
   - Test re-run with identical data (inserted: 0, skipped: N)
   - Test re-run with changed data (superseded + newRows)
   - Test auth: unauthorized rejected
   - Test auth: non-admin board user rejected
   - Verify activity_log entry created with companyId: null

4. **Write tests for compareAndSeed helper** (`server/src/services/admin/compare-and-seed.test.ts` — new file):
   - Test each branch: insert / skip / supersede
   - Test identity-field mismatch handling
   - Test the schemaLabel error paths

5. **Run full targeted test suite** to confirm 145+ tests still pass plus the new admin tests.

6. **Commit Part 2** with clean message.

7. **End-of-day documentation pass** (~30-45 min at end of Block 2):
   - PHASE-4-PROGRESS.md updated with all of today's commits
   - EA v3.3 + Brief v1.3 content drafted for Scott to add to Word
   - WIP doc Session Log final entry for today
   - Final commit

### FUTURE SESSIONS

8. **Session 3+:** Use the admin endpoints to seed pricing + thresholds (Phase 4c.1b + 4c.2b deferred runbook work). Single POST call each.

9. **Session 4+:** Resolve Q1 (charter status), Q2 (setup fees), Q3 (get-transaction-by-id scope). Each is a significant architectural piece deserving its own focused session.

10. **Sessions 5-N:** Re-implement the three write endpoints atop the now-complete safety layer. Wire Phase 4c.4 dispatcher stubs to real upstream writes.

11. **Final session:** Move all locked decisions from this WIP doc to ADR-004, summarize in PHASE-4-PROGRESS.md, update EA + Brief, delete this WIP doc.

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
