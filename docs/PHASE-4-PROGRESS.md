# Phase 4 — Accounting API Progress

**Started:** May 16, 2026 (commit 2f52a7f0)
**Active push:** May 23-30, 2026
**Goal:** All 8 endpoints production-ready with comprehensive test coverage
**Reference spec:** docs/PHASE-4-ACCOUNTING-API-SPEC.md
**Reference decision:** docs/adr/ADR-001-pattern-b-full-api-endpoints.md

## Endpoint Status (8 total)

### Read endpoints (5)
- [x] `GET /api/accounting/v1/transactions` — shipped May 16 (2f52a7f0), comprehensive tests added May 23 (8ed906d8) — 15 tests
- [x] `GET /api/accounting/v1/bills` — shipped May 23 (081a1c68) — 11 tests
- [x] `GET /api/accounting/v1/invoices` — shipped May 23 (66fd9b0c) — 11 tests
- [x] `GET /api/accounting/v1/accounts` — shipped May 23 (c45459f8) — 11 tests
- [x] `GET /api/accounting/v1/reports` — shipped May 23, multiple commits — 14 tests
  - ProfitAndLoss: working (commit 2b7777d4)
  - BalanceSheet: working (commit 671be82f)
  - TrialBalance: working (commit 363d6498)
  - CashFlow: returns 501. Xero does not expose a CashFlow report endpoint
    cross-platform, so this report type cannot be supported in v1. Open
    question for future: drop from SupportedReportType or document the
    Xero limitation more prominently.

### Write endpoints (3) — Phase 4b → deferred pending Phase 4c safety architecture
- [DEFERRED] `POST /api/accounting/v1/transactions/:txnId/category` — initial attempt May 24 (commit a449c873) reverted same day (commit 91a554f4) for trust tenet violation (previousAccountRef hardcoded to null). Service-layer refactor of updateTransactionCategory (auto-detect platform) kept. To be re-implemented in Phase 4c.5 atop safety architecture.
- [DEFERRED] `POST /api/accounting/v1/payments` — never attempted. Requires Phase 4c safety architecture (threshold caps, HITL approval queue) per design discussion May 24.
- [DEFERRED] `POST /api/accounting/v1/invoices` — never attempted. Requires Phase 4c.1 pricing (shipped) + future charter storage + setup fee handling. Documented gaps in ADR-003 Amendment 1.

**Reason for deferral:** Trust tenet recognized May 24: no real clients (beta or paying) onboarded until system is correct, trustworthy, and dialed in for security and safety of client funds. Tenet applies uniformly to client books AND Ledgerix Pro's own books (Ledgerix Pro is itself a client of its own system). Partial-spec write endpoints with documented gaps violate this. See commit 91a554f4 reasoning.

## Service Layer Functions
- [x] `getNewTransactions` — exists (supports `GET /transactions`)
- [x] `updateTransactionCategory` — exists (supports `POST /transactions/:txnId/category`)
- [x] `reconcilePayment` — exists (may need extension for paymentDate param per spec)
- [x] `getBills` — shipped May 23 (typed Bill interface, QBO + Xero implementations)
- [x] `getInvoices` — shipped May 23 (typed Invoice interface, QBO + Xero implementations)
- [x] `getAccounts` — shipped May 23 (typed Account interface, QBO + Xero implementations)
- [x] `getReports` — shipped May 23 (dispatcher + Report + ReportRow interfaces + 5 parser helpers)
  - `parseReportAmount` — safe string-to-number conversion
  - `xeroAccountIdFromCell` — extracts account UUID from Xero cell attributes
  - `flattenXeroRows` — recursive Xero hierarchy flattener (P&L, BS)
  - `flattenXeroTrialBalanceRows` — Xero TB rows with debit/credit pair handling
  - `qboAccountIdFromColData` — extracts account ID from QBO cell
  - `flattenQboRows` — recursive QBO hierarchy flattener (P&L, BS)
  - `flattenQboTrialBalanceRows` — QBO TB rows with debit/credit pair handling
- [ ] `createInvoice` — pending (for `POST /invoices` — Ledgerix Pro's own QBO billing)

## Test Coverage Status
- [x] Vitest server-side infrastructure verified working (May 23)
- [x] Mocking pattern established (vi.mock + minimal Express test app + supertest)
- [x] Test helpers created (buildTestApp, localBoardActor in accounting.test.ts)
- [x] Comprehensive tests for `GET /transactions` — 15 test cases
- [x] Comprehensive tests for `GET /bills` — 11 test cases
- [x] Comprehensive tests for `GET /invoices` — 11 test cases
- [x] Comprehensive tests for `GET /accounts` — 11 test cases
- [x] Comprehensive tests for `GET /reports` — 14 test cases (P&L + BS + TB happy paths + auth/validation/errors)

**Total tests: 62 passing, all under src/routes/accounting.test.ts**

### Pattern established for endpoint tests
- Mock service layer via vi.mock() (hoisted above route imports)
- buildTestApp(actorOverride) helper creates minimal Express app
- localBoardActor preset for tests not focused on auth
- Test categories: happy path, input validation, auth/authz, service errors, data handling
- Invocation: cd server && pnpm exec vitest run src/routes/accounting.test.ts

## Database Foundation for Phase 4b (Write Endpoints)
Shipped May 23 (commit b6f076f0) so Phase 4b implementation isn't blocked
by DB work:
- [x] `activity_log.status` column added (default 'success' NOT NULL)
- [x] `idempotency_keys` table created
  - Columns: id, companyId, key, requestHash, responseBody, responseStatus, createdAt, expiresAt
  - Unique constraint on (companyId, key)
  - Index on expiresAt for cleanup job
  - Foreign key to companies
- [x] Migration 0064_magenta_typhoid_mary.sql generated and committed
- [x] Schema files registered in packages/db/src/schema/index.ts

## Auth Infrastructure (verified May 23)
Per server/src/middleware/auth.ts: actorMiddleware already supports 5 actor scenarios:
- type "none" (unauthenticated)
- type "board" via session (better-auth)
- type "board" via API key (bearer token, agentApiKeys table NULL agentId)
- type "agent" via API key (agentApiKeys table with agentId set)
- type "agent" via JWT (verifyLocalAgentJwt path)

Two deployment modes: `local_trusted` (auto-board access for local dev),
`authenticated` (session-required for Railway production).

Implication for ADR-001 Phase 5: Agent API key infrastructure is already
built. Phase 5 reduces to allowlist middleware on top of existing actor
infrastructure — smaller scope than estimated.

## Decisions & Findings

### May 23, 2026 (session start)
- Phase 4 scope per spec: 8 endpoints total (5 read + 3 write)
- 1 of 8 shipped at start; 7 remaining
- 5 service functions need building (in addition to 7 endpoints)
- Estimated 52-74 hours total for remaining work
- 7-day execution window: 56-72 hours availability
- Conclusion: Phase 4 can fully complete this week

### May 23 (Saturday session decisions)
- **Reports endpoint design (Option B — normalize):** Decided to normalize
  cross-platform reports into our own ReportRow shape rather than passing
  through platform-native nested JSON. Trade-off: ~1.5-2x effort but matches
  the platform-agnostic spirit of the rest of the API.
- **Reports v1 scope (Path 3):** 4 report types under `/reports` (not 6).
  Aged Receivables and Aged Payables deferred — they have a fundamentally
  different shape (per-contact aging buckets, not row hierarchy) that
  doesn't fit the Report interface cleanly. Future: own endpoint(s).
- **CashFlow dropped from v1 implementation:** Xero does not expose a
  CashFlow report endpoint cross-platform. Forcing it would require
  asymmetric API (QBO-only) which breaks design goals. Returns 501 in
  the dispatcher with a clear comment.
- **Trial Balance row shape (sub-option 4):** ReportRow extended with
  optional debit?: number and credit?: number fields. For TB rows,
  amount = 0 by design; consumers MUST read debit/credit explicitly.
  Documented in interface comments.
- **First failed assumption (Option B for read endpoints):** Instance
  admin does NOT bypass company access for reads. Documented in test
  comments. Behavior is intentional.

### May 23 (Saturday session — Phase 4b foundation)
- **Idempotency design (per spec Section 2B.1):** Header-based
  (Idempotency-Key), 24-hour window, 200 OK with meta.idempotencyReplay=true
  on duplicate match, 409 Conflict on duplicate+different-body.
- **Audit log architecture (per spec Section 2B.1):** Use existing
  activity_log table. Add a status column distinguishing 'success' from
  'failure' attempts. Migration shipped May 23.
- **idempotency_keys table design:** SHA-256 request_hash for body
  comparison, JSONB response_body for replay, separate response_status
  column (replay needs exact HTTP status, not inferred from body),
  expires_at set explicitly on insert (cleanup job has one column to
  query), unique constraint on (company_id, key) for concurrent insert
  safety.

## Session Log

### 2026-05-23 Saturday (planned 8 hr; actual ~9 hr)

**10 commits shipped:**
1. 0988db5b — PHASE-4-PROGRESS.md tracker created
2. 8ed906d8 — Comprehensive tests for GET /transactions (15 tests)
3. e3abe281 — Tracker tweak
4. 081a1c68 — Bills endpoint + 11 tests
5. 66fd9b0c — Invoices endpoint + 11 tests
6. c45459f8 — Accounts endpoint + 11 tests
7. 2b7777d4 — Reports endpoint (P&L) + 12 tests
8. 671be82f — Balance Sheet support added to Reports
9. 363d6498 — Trial Balance support added to Reports (extended ReportRow interface)
10. b6f076f0 — Migration 0064: activity_log.status + idempotency_keys table

**Endpoint progress:** 5 of 8 production-ready (62.5%). Originally planned 2.

**Tests:** 62 passing (from 0 at session start)

**Service layer:** 7 of 8 service functions complete (createInvoice for /POST invoices remains)

**Phase 4b foundation:** Database schemas + migrations in place for write endpoints

#### Findings & re-discoveries
- Server vitest.config.ts was bare (just environment:node) — no setup needed beyond what existed
- supertest and @types/supertest already installed
- No `test` script in server/package.json; invoke via `pnpm exec vitest run <file>`
- activity_log table already existed with rich field set (no schema work needed beyond status column)
- idempotencyKey term already used in codebase but only in agent/heartbeat contexts, not HTTP — pattern established here is HTTP-specific
- Drizzle migration workflow: update schema TS files → pnpm generate → drizzle-kit auto-creates SQL + snapshot

### 2026-05-24 Sunday (planned 12-14 hr) — ACTUAL: architectural pivot

**Original plan:** Ship the 3 write endpoints.

**Actual outcome:** Shipped 1 write endpoint, reverted it after recognizing a trust tenet violation, pivoted to designing and implementing Phase 4c safety architecture instead. Phase 4c.1 (pricing source of truth) shipped successfully. The architectural pivot was the right call but means Phase 4 endpoints are now blocked on Phase 4c.2-4c.5 work.

**Commit log (in order):**

1. **a449c873** — POST /transactions/:txnId/category route shipped with 17 tests. Service-layer refactor of updateTransactionCategory (auto-detect platform). Service function returns {platform}. Route hardcoded previousAccountRef: null in response shape.

2. **91a554f4** — REVERTED the route + tests. Service-layer refactor kept. Reason: previousAccountRef: null in the response/audit-log shape violated the trust tenet (partial-spec compliance on a write endpoint that touches financial records). Test code preserved in docs/deferred/ for future re-implementation reference.

3. **1fca9a11** — ADR-003 Phase 4c Safety Architecture (Accepted, with 10 design decisions). Five pieces: pricing, dedupe, thresholds, approval-system integration, read verification. Read verification deferred to Phase 5. Reuses existing approvalService — no new HITL queue needed.

4. **104e82fb** — Phase 4c.1 pricing source of truth. New schemas: service_tier_pricing, client_pricing_overrides. New service function: getExpectedPriceCents(db, tier, isCharter, contactId?). 10 unit tests. Migration 0065_whole_post.sql.

5. **6283ebfc** — ADR-003 amended with 3 architectural gaps surfaced during EA v3.3 / Brief v1.3 re-read:
   - Gap 1: Charter status has no defined storage in the architecture (caller can't reliably populate isCharter)
   - Gap 2: Setup fees ($249/$349/$1,200 per tier) not modeled by Phase 4c.1 schema
   - Gap 3: Tier Qualifier matrix not codified as data (lives in agent prompts)
   - Also corrected stale pricing values throughout ADR-003 ($499→$599, $799→$999, $899→$1,299) — original draft predated May 17 EA v3.2 repricing

**Architectural decisions reached today:**

- **Trust tenet established and documented**: No real clients (beta or paying) onboarded until system is correct, trustworthy, and dialed in for security and safety of client funds. Applies uniformly including to Ledgerix Pro's own books. No partial-spec write endpoints. Time is reference for planning, not a gate for go/no-go decisions.

- **Phase 4 architecture pattern**: Every write endpoint sits atop a safety layer (Phase 4c). Endpoint flow becomes: validate → safety checks → if pass: upstream call + audit + idempotency; if fail: create approval (202 Accepted) + audit + idempotency.

- **Approval system reuse**: Existing approvalService (created/approve/reject/comment/revision methods) extended with new dot-namespaced types (accounting.payment.threshold_exceeded, etc.) rather than building parallel HITL infrastructure.

**Open architectural questions answered today:**

- Idempotency replay: returns the 202 forever, regardless of approval status. Strict contract: same request → same response. Agent polls GET /api/approvals/:id for current status. (ADR-003 Q5)

- Two-phase failure handling: upstream-first ordering per ADR-002 D2. Upstream call inside the work callback; audit log success AFTER upstream success; audit log failure BEFORE returning 502.

- CashFlow: still returns 501. No decision change. Open for future.

**End-of-day tally:**

- Tests: 86 passing (62 accounting + 14 idempotency + 10 pricing)
- Phase 4 endpoint progress: 5 of 8 production-ready (62.5% — no change since Saturday)
- Phase 4c progress: 1 of 5 pieces shipped (4c.1)
- Architectural debt acknowledged: Charter storage, setup fees, Tier Qualifier matrix — all deferred with options identified

### 2026-05-24 Sunday (continued — afternoon + evening session)

After the morning's Phase 4c.1 work + ADR-003 amendments, the same Sunday continued through the afternoon and evening. The Monday plan above was OBSOLETED by Sunday completing most of it ahead of schedule.

**Commit log (in order, continuing from morning):**

6. **9bb4dc68** — PHASE-4-PROGRESS.md tracker update reflecting Sunday morning state.
7. **7fce967b** — **Phase 4c.2 (Threshold framework) COMPLETE.** New schema write_thresholds. New service: getApplicableThresholds, getMostSpecificThreshold, isThresholdExceeded. 14 unit tests. Migration 0066_familiar_nighthawk.sql. Hierarchical thresholds (per-client > global). Per-client overrides can either tighten or loosen vs global. Bootstrap data DEFERRED to runbook (Phase 4c.2b).
8. **43d6e144** — **Phase 4c.3 (Customer dedupe refactor) COMPLETE.** Refactored findOrCreateCustomer to return {customerId, action, matchDetails?}. Five action types: 3 auto-proceed (found_by_email, found_by_name_exact, created_new) + 2 HITL-required (ambiguous_name_only, ambiguous_email_match_different_name). New utility module: string-similarity.ts (normalizeName, levenshteinDistance, namesAreSimilar). 25 tests for string-similarity + 9 for findOrCreateCustomer. Real bug caught during testing: empty stored DisplayName was treated as ambiguous; fixed to treat empty as "no conflict."
9. **e7cec441** — **Phase 4c.4 (Write-approval dispatcher) COMPLETE in stub mode.** New module: services/accounting/write-approvals.ts. 4 dot-namespaced approval type constants + 4 typed payload interfaces (per ADR-003 Q1+Q2). executeApprovedAccountingWrite dispatcher in stub mode (logs but doesn't yet wire to upstream writes — Phase 4c.5 will replace stubs with real calls). approvalService.approve() extended with dispatcher call for accounting.* types. 11 tests.
10. **c9ab53f9** — **WIP doc convention established + CLAUDE.md session-startup guide created.** Repo root CLAUDE.md captures 5 critical operating principles: trust tenet, verify before assuming, session-end doc discipline, locked decisions stay locked, WIP docs are truth for active work. docs/wip/README.md defines the WIP doc convention (required sections, discipline rules, when to create/remove). This is multi-session continuity infrastructure for architectural work that spans days.
11. **e618231b** — **Phase 4c.5 Part 1 shipped.** Migration 0067_last_gateway.sql makes activity_log.companyId nullable (architectural Decision B). LogActivityInput type accepts string | null. publishLiveEvent and PluginEvent emissions skipped when companyId is null (Option 1). New generic helper services/admin/compare-and-seed.ts implementing version-aware idempotency per Phase 4c.5 Decision 3. Phase 4c.5 WIP doc shipped with Decisions 1, 2 (revised), 3 locked.
12. **06d2fffb** — Phase 4c.5 WIP doc Session Log updated for Block 1 end-of-block (Scott taking 3-hour break before Block 2).

**Architecture decisions reached Sunday afternoon/evening (incremental to ADR-003):**

- **WIP doc convention** for multi-session work. ALL future multi-session architectural work goes through docs/wip/ with required structure: Status / Decisions Made / Decisions Pending / Work Done / Next Steps / Blockers / NOT Doing / Session Log. Discipline: update at every session end; locked decisions stay locked; rejected options stay rejected; Session Log append-only.

- **Phase 4c.5 Decision 1 (locked):** Admin HTTP endpoints (not one-time scripts) for safety-layer data management — pricing, thresholds, future per-client overrides. Driven by 7-year audit retention requirement. Scripts can't deliver durable audit trails.

- **Phase 4c.5 Decision 2 (revised):** Admin endpoints use existing assertInstanceAdmin from authz.ts. Originally locked as "session-only first; CI/CD bearer path committed for future." REVISED in same session after reading the actual auth middleware code — board_key path captures userId. The existing assertInstanceAdmin natively supports session, board_key, and local_implicit paths — all identity-tracked. Real lesson: the original Decision 2 was locked without first grepping the auth code (violated memory #7 verify-before-assuming).

- **Phase 4c.5 Decision 3 (locked):** Version-aware idempotency for admin seed endpoints (Option D-modified). Per candidate row: identical to active row → skip; different from active → supersede (effective_to=NOW(), insert new); no active row → insert. Returns {inserted, skipped, superseded, newRows}. Implemented as generic compareAndSeed helper.

- **Phase 4c.5 Decision B (locked):** activity_log.companyId nullable for system-scoped admin operations. Considered alternatives (use Ledgerix Pro's companyId, sentinel UUID) rejected for semantic dishonesty.

- **Phase 4c.5 Option 1 (locked):** Live-events and plugin-events suppressed when companyId is null. The current operations dashboard monitors agent health (not activity streams), so admin operations don't need real-time broadcast. Activity log query remains source of truth.

**NOT Doing (explicitly rejected Sunday):**
- One-time scripts for seeding (rejected: audit retention requires DB-backed activity log)
- Every-category-update-needs-approval (rejected: doesn't scale to 50+ clients)
- previousAccountRef: null placeholder (rejected: trust tenet)
- Use Ledgerix Pro's companyId for admin operations (rejected: semantic dishonesty + future SaaS conflict)
- Sentinel UUID for system-scoped broadcasts (rejected: inconsistency between DB row and broadcast)
- System-wide event channel via publishLiveEvent (rejected for now: dashboard doesn't need this; revisit if future dashboard view does)

**Sunday end-of-day tally:**

- Total Sunday commits: 12 (1 reverted, 11 net forward progress)
- Tests: 145 passing (62 accounting + 14 idempotency + 10 pricing + 14 thresholds + 25 string-similarity + 9 findOrCreateCustomer + 11 write-approvals)
- Phase 4c progress: 4 of 5 pieces complete (4c.1, 4c.2, 4c.3, 4c.4). 4c.5 has WIP doc + Part 1 shipped (nullable companyId, compareAndSeed helper); Part 2+ pending.
- Phase 4 endpoint progress: 5 of 8 production-ready — UNCHANGED (write endpoints still deferred behind safety layer)
- Architecture decisions locked Sunday: 10 ADR-003 decisions + 3 ADR-003 amendments + 4 Phase 4c.5 decisions (1, 2-revised, 3, B) + Option 1 + WIP convention
- WIP infrastructure: CLAUDE.md + docs/wip/README.md + Phase 4c.5 WIP doc active
- User memories added/updated: #7 (verify before assuming), #8 (CI/CD bearer-token triggers)

**State at Sunday end-of-day:**

- Codebase HEAD: master @ 06d2fffb (will be 06d2fffb-or-later after end-of-day documentation pass)
- All committed work is on Railway main branch
- admin.ts file drafted in working tree but typecheck-failing (3 errors); INTENTIONALLY uncommitted; Phase 4c.5 Part 2 will fix these
- WIP doc has explicit Block 2 todo list — next session can pick up cleanly

### 2026-05-25 Monday — Phase 4c.5 Part 2 shipped

**Goal:** Complete Phase 4c.5 Part 2 (admin endpoints atop Sunday's foundation).

**Commit shipped:**

13. **ff3875e8** — **Phase 4c.5 Part 2 COMPLETE.** Fixed 3 typecheck errors in admin.ts (the .ts→.js import + two effectiveToField type errors via Option A generics refactor: TRow defaulted to TSchema["$inferSelect"] so the helper's keyof TRow & string union becomes the real schema columns, not just the candidate row's identity+value fields). Mounted admin router in app.ts alongside other instance-admin routes. Added 7 helper unit tests + 9 endpoint integration tests. 161 targeted tests passing (145 baseline + 16 new). Full monorepo typecheck clean.

**Architecture decisions reached:**

- None new. Decision 2 (revised) auth pattern + Decision 3 idempotency pattern from Sunday's WIP doc were applied without re-litigation.

**Implementation decision worth flagging:**

- **compareAndSeed generics refactor (Option A over B and C):** Original two-generic form `<TSchema extends PgTable, TRow>` inferred TRow from candidateRows (identity+value fields only), so `"effectiveTo"` wasn't in the type union — that was the root cause of the lines-75/144 errors. Chose Option A (default TRow to TSchema["$inferSelect"]) over B (widen candidate rows at every call site) and C (loosen effectiveToField to plain string), because A is the closest match to the helper's design intent. Runtime guards check column existence on the table; the compile-time type should match that the keys are table columns, not candidate-row keys. Verified $inferSelect is the standard codebase pattern (access.ts, xero-client.ts, qbo-client.ts, write-approvals.ts, execution-workspaces.ts) before refactoring.

**State at session end:**

- Codebase HEAD: master @ ff3875e8 (pushed to GitHub master)
- 161 targeted tests passing (145 baseline + 16 new across compare-and-seed.test.ts + admin.test.ts)
- Full monorepo typecheck clean
- Phase 4c.5 Part 2 complete; bootstrap deferred as the next deliberate action
- Phase 4c progress: 4 of 5 pieces complete + 4c.5 Part 1 + Part 2 shipped; 4c.5 bootstrap + remaining Q's pending
- Phase 4 endpoint progress: 5 of 8 production-ready (UNCHANGED — write endpoints still deferred behind safety layer + Q's)

**What was deferred during the session:**

- Bootstrap of canonical pricing + thresholds via the seed endpoints. The endpoints are tested and ready; bootstrap is a deliberate operator action against the right environment (most likely Railway prod via the board API key path) — not a side effect of local dev work. Local dev env isn't yet isolated from prod credentials (memory TODO Option B). Avoided a sleepwalk into a side-effectful prod write disguised as local dev.

**End-of-day update (~1 hour after the Part 2 commit):**

Bootstrap proceeded with deliberate care: pre-flight HTTP probe confirmed deploy live (`403 {"error":"Board access required"}` from unauth'd POST proved the endpoint was mounted); psql verification of the board_api_keys row confirmed the bearer token resolves to admin@ledgerixpro.com with instance_admin role.

**Bootstrap results:**
- `POST /api/admin/pricing/seed` → HTTP 200, `inserted: 6`. psql verified 6 rows match canonical values. activity_log captures the operation under admin@ledgerixpro.com's user identity, `company_id = NULL` per Decision B.
- `POST /api/admin/thresholds/seed` → HTTP 200, `inserted: 2`. psql verified 2 rows match EA Section 6.3 canonical values. activity_log captures the operation.

**Idempotency re-run exposed a null-identity bug:**

Re-running both seeds was supposed to demonstrate Decision 3's idempotency contract (`skipped: N`). Pricing held the contract perfectly. Thresholds did NOT — re-run returned `inserted: 2` (should have been `skipped: 2`), creating duplicate active rows in `write_thresholds`.

Root cause: the compareAndSeed helper uses `eq(col, value)` to build identity-match WHERE conditions, including when value is null. `eq(col, NULL)` never matches in SQL (not even NULL=NULL). Pricing's identity tuple `[tier, isCharter]` has no nulls so it works correctly. Thresholds' identity tuple `[endpoint, field, ghlContactId]` is null on global thresholds, breaking the lookup.

Unit tests didn't catch this because the mock `db.where()` is a no-op pass-through — the mock returns whatever the test pre-seeded regardless of what WHERE conditions were built. Tests verified call shape, not SQL semantics. Generalizable lesson: helpers that build SQL predicates with edge cases (nulls) need integration tests, not just mocked unit tests.

Cleanup: 2 duplicate rows in `write_thresholds` hard-DELETED to restore correct state. activity_log entries preserved (audit retention is sacred). Both data tables now correct in prod.

**Bug + fix documented in Phase 4c.5 WIP doc** under new "Defects Discovered" section. Fix (helper change + integration tests) is now the IMMEDIATE next work item in the WIP doc, ahead of write-endpoint re-implementation.

### 2026-05-26 Tuesday — Phase 4c.5 Defect 1 fixed and verified in prod

**Goal:** Fix the compareAndSeed null-identity bug (Path A) discovered Monday end-of-day.

**Commit shipped:**

14. **`1727746a`** — **fix(admin,phase-4c-5): compareAndSeed null-identity SQL bug + integration tests.** Helper now uses `isNull(column)` when candidate value is null instead of `eq(column, null)` (which never matches in SQL). New integration test file `server/src/services/admin/compare-and-seed.integration.test.ts` — 3 tests against real embedded Postgres via existing `startEmbeddedPostgresTestDatabase` infrastructure. Tests written TDD-style: 2 tests verified FAILING against unfixed helper before fix; all 3 PASS after.

**TDD discipline applied:**

The Session 2 lesson ("unit tests with fluent-chain mocks can verify call shape but NOT SQL semantics") drove the test-first approach. Integration tests against real Postgres were written FIRST, then run against the unfixed helper to confirm they catch the bug. Tests 1 and 2 failed as expected with the exact symptom from prod (`inserted: 1` instead of `skipped: 1`). Only THEN was the helper fix applied. After the fix, all 3 tests pass. This proves: (a) the tests actually catch the bug (vs being confirmation-bias-passing tests), and (b) the fix actually resolves it.

**Production verification:**

After commit + Railway auto-deploy completed (~3 min), re-ran `POST /api/admin/thresholds/seed` against Railway prod via the board API key. Result:

- HTTP 200
- Response body: `{"data":{"inserted":0,"skipped":2,"superseded":0,"newRows":0}}` — exact Decision 3 idempotency contract
- activity_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95` captures the post-fix re-run under admin@ledgerixpro.com
- psql verified `write_thresholds` still has exactly 2 active rows with the SAME `id`s as the 2026-05-25 18:58 initial seed — no duplicates created

The original Monday 19:00 prod failure scenario is now passing. Original bug → fix → verification arc is permanently captured in 3 chronological activity_log rows: `99273b65` (correct initial), `8e55d843` (buggy re-run), `e6d8b7f5` (post-fix re-run with contract restored).

**State at session end:**

- Codebase HEAD: master @ `1727746a` (pushed to GitHub master, deployed to Railway prod)
- Test baseline: 164 targeted tests passing (Session 2 baseline of 161 + 3 new integration tests)
- Full monorepo typecheck: clean
- Phase 4c progress: 4 of 5 pieces complete + 4c.5 Parts 1 & 2 shipped + bootstrap done + null-identity defect FIXED
- Phase 4 endpoint progress: 5 of 8 production-ready (UNCHANGED — write endpoints still gated)

**Integration test infrastructure established as a pattern:**

The Session 2 lesson is now codified as executable infrastructure. Any future helper that builds SQL predicates with edge cases (nulls, type coercion, complex joins) should follow this pattern: integration tests against real Postgres via `startEmbeddedPostgresTestDatabase`, not just mocked unit tests. The infrastructure already existed in the codebase (used by costs-service.test.ts and others); Session 3 surfaced it as the right pattern for admin/safety-layer testing too.

**Q3 locked as Decision 4 (later in Session 3):**

After Defect 1 was fixed and verified, scoping work resumed on Q3 (get-transaction-by-id infrastructure scope). Code reading in `server/src/services/accounting/index.ts` surfaced a critical clarifying fact: the current `updateTransactionAccount` for QBO and Xero already implements the type-specific GET-by-id pattern for ONE type per platform (QBO Purchase via `GET /purchase/{id}`; Xero BankTransaction via `GET /BankTransactions/{id}`). They just don't surface the fetched data to callers. Q3 isn't "build getTransactionById from scratch" — it's "extract the existing pattern, generalize, and decide how many types to cover."

**Decision: Option A (full coverage).** Per-type fetch handlers for 7 QBO types (Purchase ✅, Bill, JournalEntry, Deposit, BillPayment, Payment, Invoice) + 4 Xero types (BankTransactions ✅, Invoices, Bills, ManualJournals). Locked as Decision 4 in the WIP doc with: a unified `TransactionLookupResult` interface contract, a per-type implementation checklist, explicit out-of-scope clarifications (per-type interface details deferred to implementation time; rarer QBO types remain in approval fallback; QBO Invoice recategorization semantics deferred). Estimated implementation effort: 5-7 hours.

**Why Option A:**

- Option C (every category update creates approval) was previously rejected as not scaling to 50+ clients.
- Option B (common types only, rest fall back to approval) creates a two-tier reliability story.
- The marginal cost per additional type is bounded — each follows the established pattern (minimal interface with `[key: string]: unknown` catch-all, per-type GET endpoint, register with dispatcher).
- The Phase 4c.4 approval fallback (`accounting.transaction.category_with_unknown_previous`) remains as a safety net for truly unrecognized txnIds. Option A shrinks the "unknown" zone to near-zero rather than removing it.

**Honest caveats captured in Decision 4:**

- The "try each type-specific endpoint until 200" dispatcher strategy assumes QBO and Xero's APIs distinguish "wrong type" from "not found" in their error envelopes. QBO does this cleanly; Xero needs verification at implementation time.
- QBO Invoice is sales-side (income account, not expense). Whether agent recategorization of Invoice lines is legitimate or always-HITL is a sub-decision deferred to implementation; default to HITL if uncertain.

**WIP doc edits to reflect lock:** Decision 4 added to "Architecture Decisions Made" (90 lines covering reasoning, scope, interface contract, dispatcher strategy, per-type checklist, out-of-scope, effort estimate, blast radius, verification approach). Q3 compressed in "Architecture Decisions Pending" to a 3-line resolved-pointer. IMMEDIATE section: new item 10 added for the implementation work itself. Estimated remaining work line updated. Future sessions list cleaned up (Q3 removed; Q1 + Q2 remain).

**State at session end (final):**

- Codebase HEAD: master @ `59e81566` + this docs commit pending
- Phase 4c.5 Defect 1: FIXED + verified + documented
- Phase 4c.5 Q3: LOCKED as Decision 4 (implementation pending — 5-7 hours estimated)
- Phase 4c.5 Q1 + Q2: still pending, each its own focused session
- Test baseline: 164 targeted tests passing (unchanged since Defect 1 fix)
- IMMEDIATE next work: Implement Decision 4 (next deliberate code session)

**Decision 4 Phase 1 shipped (later in Session 3):**

After locking Decision 4 in docs, Session 3 continued with implementation work. Phase 1 of N — establishing the dispatcher infrastructure and proving the pattern works on existing code — shipped as commit `bffa3b16`.

**Commit shipped:**

15. **`bffa3b16`** — **feat(accounting,phase-4c-5): Decision 4 Phase 1 — getTransactionById dispatcher + 3 type handlers.** New `transaction-lookup.ts` module with the unified `TransactionLookupResult` interface, `TransactionNotFoundError` class, and `getTransactionById` dispatcher. Initial coverage: 3 of 11 types (QBO Purchase ✅ extracted, QBO Bill ✅ NEW, Xero BankTransaction ✅ extracted). Existing `qbo.updateTransactionAccount` and `xero.updateTransactionAccount` refactored to use the dispatcher with `hintedType` set. Log lines now include `previousAccountRef`. New test file `transaction-lookup.test.ts` with 15 tests (11 unit + 4 integration). Test baseline: 164 → 179 targeted tests passing. Typecheck clean.

**TDD-adjacent discipline applied:**

Phase 1 is code-first rather than strictly test-first (the dispatcher pattern was new and worth experiencing before testing). But the unit + integration test suite was written immediately after the implementation, while the design was fresh, and verified to pass against the implementation before commit. The 15 tests cover the hinted-type fast path (4), multi-type probing including the TransactionNotFoundError exhaustion path (4), previousAccountRef extraction edge cases (3), and real-DB integration including the null-contactId path (4). The null-contactId integration test is particularly valuable: it proactively covers the same class of bug as Phase 4c.5 Defect 1 (SQL null-equality), preventing recurrence in this new code path.

**Generalizable observation surfaced during Phase 1:**

The dispatcher's multi-type probing currently has a single-iteration safety property: all existing callers (the two refactored `updateTransactionAccount` handlers) pass a `hintedType`, so the multi-type loop never actually iterates. When the first "general" (no-hint) caller is added — most likely the re-implemented `POST /transactions/:txnId/category` endpoint — error discrimination becomes necessary. Currently `qboRequest`/`xeroRequest` throw generic `Error` on 404 with no structured status, making a "wrong type" 404 indistinguishable from a transient 500 in the catch handler. The fix is captured in the WIP doc as Phase 2 scope: introduce `class HttpResponseError extends Error` with `status: number` in the platform clients, then have the dispatcher catch `error instanceof HttpResponseError && error.status === 404` for continue-loop semantics, rethrowing everything else. This is the kind of issue that's much cheaper to surface during scoping than to debug later — Phase 1 design exposed it cleanly.

**State at session end (truly final):**

- Codebase HEAD: master @ `bffa3b16` (plus this docs commit pending)
- Test baseline: 179 targeted tests passing (164 + 15 from transaction-lookup)
- Full monorepo typecheck: clean
- Phase 4c.5 status:
  - Defect 1: FIXED + prod-verified ✅
  - Decision 4 (Q3 resolution): LOCKED + Phase 1 SHIPPED ✅ (3 of 11 types)
  - Decision 4 Phase 2+: pending (5 QBO types + 3 Xero types + HTTP error class, ~4-5 hours)
  - Q1 (charter status): still pending
  - Q2 (setup fees): still pending
- IMMEDIATE next work: Decision 4 Phase 2 (add structured HTTP error class + 1-2 more types per platform) OR Q1/Q2 architectural decisions

### Session 4 — 2026-05-27 (Wednesday)

**Goal:** Decision 4 Phase 2 — the structured HTTP error class identified during Phase 1 as the prerequisite for safe multi-type probing.

**Architecture decisions reached:**
- None new. Decision 4 (Option A — full coverage) lock from Session 3 governed this session's work without re-litigation. Phase 2 is implementation of the locked decision, scoped per the WIP doc's Phase 1 generalizable observation.

**Commit shipped:**

16. **`635e4998`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 foundation — HttpResponseError + strict dispatcher discriminator.** New `server/src/services/accounting/http-error.ts` module (32 lines) exporting `HttpResponseError extends Error` with `status: number`, `method: string`, `path: string`, optional `responseBody: string`, plus an `isNotFound` getter. `qboRequest` (`qbo-client.ts`) and `xeroRequest` (`xero-client.ts`) refactored to throw `HttpResponseError` instead of generic `Error` on non-OK responses; error message strings byte-identical to preserve debugging output. `getTransactionById` dispatcher's multi-type probing catch block tightened from unconditional continue to strict discriminator: `instanceof HttpResponseError && error.isNotFound` continues; everything else rethrows. 3 new tests lock the strict semantics. Test baseline: 179 → 182 targeted tests passing. Full monorepo typecheck clean.

**Phase 2 foundation completes the work the Phase 1 generalizable observation predicted:**

Session 3's Phase 1 commit message explicitly flagged the HTTP error discriminator gap — the multi-type probing loop was "single-iteration-safe today" because all existing callers pass `hintedType`, but the moment a general (no-hint) caller is added — or the moment a second QBO type is registered causing the loop to iterate — the catch needs to distinguish 404 (try next type) from 500 (genuine upstream failure, propagate). Phase 2 closes that gap before adding any new types. The reasoning was: get the foundation right first, then add types on top of a robust dispatcher.

**Mock lifecycle lesson worth flagging (generalizable beyond this work):**

The strict-catch change initially broke 7 transaction-lookup tests. Root cause was NOT the strict semantics themselves — it was `vi.clearAllMocks()` in three `beforeEach` blocks. `clearAllMocks()` clears call history but does NOT drain queued `.mockResolvedValueOnce`/`.mockRejectedValueOnce` implementations. Under the prior loose-catch dispatcher, every queued mock got consumed per test (the loop iterated through all types), so the queues were empty by the next test. Under Phase 2 strict semantics, fewer mocks are consumed per test (strict rethrow short-circuits the loop on the first non-404), so leftover queued mocks leaked forward and corrupted subsequent tests. Fix: `vi.resetAllMocks()` instead — drains the queues correctly. This is a generalizable Vitest pattern, not specific to transaction-lookup. Saved to working memory for future test work across the codebase.

**Decision 4 Phase 2 type expansion — full arc shipped Session 4:**

After the Phase 2 foundation landed, the session continued through the full type-expansion work. Path Y (one type per commit) was the chosen discipline because each remaining QBO type had structurally different account-ref locations that warranted per-commit verification against QBO API docs. Six type-expansion commits + one REVISED note commit + one feature-complete commit.

**Commits shipped (continuation):**

17. **`8830f206`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion — QBO JournalEntry.** First non-Purchase-shaped QBO type. Field path: `Line[0].JournalEntryLineDetail.AccountRef.value`. Verified against QBO API. JournalEntries are multi-line (Debit/Credit pairs) — captures first-line approximation with JSDoc-documented caveat. 1 new test. Surfaced memory #21 (the type-exhaustion test is coupled to QBO_TYPE_REGISTRY cardinality). Test baseline 182 → 183.

18. **`7027c79a`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion — QBO Deposit.** Two-account-ref nuance: top-level DepositToAccountRef (destination bank account) AND per-line DepositLineDetail.AccountRef (source). Per-line source captured (re-categorization workflows act on source side). 1 new test. Test baseline 183 → 184.

19. **`2195544a`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion — QBO BillPayment.** Structurally different from prior types: PayType-discriminated top-level account refs (CheckPayment.BankAccountRef OR CreditCardPayment.CCAccountRef). Lines contain only LinkedTxn references — no per-line account info. 3 new tests covering Check / CreditCard / unknown PayType (defensive null). Test baseline 184 → 187.

20. **`769a39ca`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion — QBO Payment.** Customer-side counterpart to BillPayment but without PayType discriminator. Two top-level refs (DepositToAccountRef = destination, ARAccountRef = AR account). Destination captured with AR fallback (different from Deposit's source-side capture; asymmetry documented in JSDoc because Deposit/Payment have opposite money flows). 3 new tests covering DepositTo present / DepositTo missing → AR fallback / both missing → null. Test baseline 187 → 190.

21. **`bf96d2d3`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion — QBO Invoice (QBO half COMPLETE).** Most structurally unique QBO type: Lines mix multiple DetailType variants (SalesItemLineDetail, SubTotalLineDetail, DescriptionOnlyLineDetail). Handler uses `.find()` to locate first SalesItemLineDetail, then extracts SalesItemLineDetail.ItemAccountRef.value (NOT ItemRef — ItemRef points to an Item, ItemAccountRef resolves to the income account on GET responses). 3 new tests covering happy path + SubTotal/Description filtering + pathological no-sales-line fallback. **QBO type registry now 7 of 7 complete.** Test baseline 190 → 193.

22. **`fb13f98c`** — **docs(wip): Decision 4 REVISED — Xero Invoice and Bill share an endpoint (Tenet #16 explicit revision).** Mid-implementation discovery: Xero treats ACCREC (sales Invoice) and ACCPAY (purchase Bill) as the same resource type, served by the same `/Invoices/{InvoiceID}` endpoint with a Type field discriminator. Original Decision 4 spec anticipated 4 separate Xero handlers; this revision documents that 3 handlers will cover 4 type keys (Invoice + Bill share a handler). Per Tenet #16 (Locked Decisions Stay Locked), the doc revision shipped BEFORE the code that diverges from the original spec — the contract was updated first. Pure docs, no code, no test changes.

23. **`4e9d70be`** — **feat(accounting,phase-4c-5): Decision 4 Phase 2 type expansion COMPLETE — Xero Invoice/Bill/ManualJournal.** Final implementation commit closing Decision 4. Two handlers shipped: `fetchXeroInvoiceOrBill` (shared, registered under both "Invoice" and "Bill" keys, returns txnType based on response Type field) and `fetchXeroManualJournal` (separate, at `/ManualJournals/{id}`, JournalLines first-line approximation). 5 new tests covering ACCREC → "Invoice", ACCPAY → "Bill" with hint "Bill" (verifies shared-endpoint behavior), defensive default when Type missing, ManualJournal happy path, ManualJournal empty-lines null fallback. **All 11 Decision 4 types now covered.** Test baseline 193 → 198.

**Decision 4 feature-complete summary:**

By end-of-session: dispatcher covers all 11 planned transaction types via 10 handler functions (7 QBO + 3 Xero — the shared-handler pattern saved one Xero handler vs the original 11-handler plan).

| Platform | Type Keys | Handler Functions |
|----------|-----------|-------------------|
| QBO      | 7         | 7                 |
| Xero     | 4         | 3 (Invoice + Bill share `fetchXeroInvoiceOrBill`) |
| **Total** | **11**   | **10**            |

Test baseline trajectory: 161 (Session 3 start) → 164 (Defect 1 integration tests) → 179 (Phase 1) → 182 (Phase 2 foundation) → 198 (Phase 2 type expansion COMPLETE). +37 tests across Decision 4. Every new code path locked by at least one dedicated test; handlers with multiple branches (BillPayment, Payment, QBO Invoice, Xero Invoice/Bill) shipped 3+ tests apiece.

**Path Y discipline retrospective:** One commit per QBO type, then the 3 Xero types batched into one commit because they share an API endpoint pattern. Path Y proved out — verification against API docs before each commit caught one significant revision (the Xero shared-endpoint discovery). If Path Y hadn't been the discipline, the Xero revision would likely have been discovered during a batched commit and either silently absorbed (Tenet #16 violation) or surfaced as a noisy mid-commit course correction. Documenting the revision as its own commit before the divergent code was the right ordering.

**Memory captures across the day:**

- **#21 (Decision 4 Phase 2 type expansion gotcha):** the type-exhaustion test is coupled to QBO_TYPE_REGISTRY cardinality. Every new type added requires growing the mock queue AND the attemptedTypes assertions. Locked via NOTE comment in the test file + memory. Came in handy 6 times across the type-expansion commits.

**Decision 5 + Pieces A/B/C — Phase 4c.5 write dispatcher + endpoint shipped (continuation of Session 4 work):**

After Decision 4 closed feature-complete, the session continued with the write-side counterpart (Decision 5) plus the three Pieces (A/B/C) needed to land the POST /transactions/:txnId/category endpoint end-to-end. Locked decision → foundation → per-type handlers → integration → approval wiring → endpoint route → tests at each stage. The complete arc shipped in a single session over 10 commits.

**Commits shipped (Decision 5 arc):**

24. **`07c056e5`** — **docs(wip): Decision 5 LOCKED — write-side dispatcher scope.** Per Tenet #16, the contract is locked in docs BEFORE any code implementing it. Decision 5 covers 6 of 11 read types — the asymmetry with Decision 4 is by design (some types don't have a meaningful "category" to update; multi-line journals require Debit/Credit balance preservation deferred to a new Q5 question). Three sub-options surfaced and decided: D5-B (only supported types in registry, excluded types throw typed error) + Sub-D5-iii (defer journal types to Q5). Pure docs, no code, no test changes.

25. **`69505e90`** — **feat(accounting,phase-4c-5): Decision 5 foundation — write-side dispatcher module + integration shim.** New `transaction-write.ts` module exports the WriteHandler type, public `updateTransactionCategory` orchestrator, `TransactionTypeNotCategorizableError` class (distinct from Decision 4's TransactionNotFoundError), and empty per-platform write registries. Tests cover the 5 excluded types throwing the right error + propagation tests + error class constructor. Existing service-level updateTransactionCategory in index.ts refactored to delegate to the new dispatcher (return shape additively expanded from {platform} to {platform, txnType, previousAccountRef}). Test baseline 198 → 206 (+8 tests).

26. **`d90d5304`** — **Handler #1: QBO Purchase.** First per-type write handler. Mutates Line[0].AccountBasedExpenseLineDetail.AccountRef via spread-merge; POSTs full transaction to /purchase?operation=update. 3 tests (happy path / field preservation / no-line-items pathological). Establishes the per-type pattern. Test baseline 206 → 209.

27. **`034ac5c4`** — **Handler #2: QBO Bill.** Structurally identical to Purchase (same shared QboAccountBasedExpenseTxnForWrite interface introduced this commit). Different write endpoint (/bill?operation=update). 3 tests. Test baseline 209 → 212.

28. **`eb77d817`** — **Handler #3: QBO Deposit (QBO half COMPLETE).** Different line shape (DepositLineDetail.AccountRef, not AccountBasedExpenseLineDetail). Critical design decision documented: handler mutates per-line source AccountRef ONLY, not top-level DepositToAccountRef (destination bank account). Test 1 dual-asserts both the per-line mutation AND the destination preservation. 3 tests. Test baseline 212 → 215.

29. **`5f30c3b2`** — **Handler #4: Xero BankTransaction.** First Xero write handler. Three structural differences from QBO documented in handler JSDoc: AccountCode is plain string (not wrapper object), POST /BankTransactions serves both create-and-update (no ?operation=update query), body wraps in BankTransactions array. 3 tests. Test baseline 215 → 218.

30. **`e7ee3273`** — **Handler #5: Xero Invoice/Bill shared (Decision 5 FEATURE-COMPLETE).** Same shared-handler pattern as Decision 4's REVISED note: one handler function registered under BOTH "Invoice" and "Bill" registry keys; same /Invoices endpoint serves both ACCREC and ACCPAY; Type field preserved on writeback. 4 tests (ACCREC → Invoice / ACCPAY → Bill same handler / field preservation / no-lines error message uses lookup.txnType for caller-correct messaging). Decision 5 final coverage: 6 type keys covered by 5 handler functions (Xero Invoice/Bill share). Test baseline 218 → 222.

**Commits shipped (Pieces A/B/C):**

31. **`b7da7478`** — **refactor(accounting,phase-4c-5): Piece A — Decision 5 final integration.** Three changes: (1) Extended updateTransactionCategory signature with optional hintedType?: string parameter (Tenet #16 compliant interface EXTENSION); (2) DELETED legacy qbo.updateTransactionAccount + xero.updateTransactionAccount methods from services/accounting/index.ts (zero callers verified) plus 5 orphaned local interfaces (~85 lines removed); (3) Updated 2 stale comment references. Single canonical write entry point established. +2 tests (hintedType plumbing). Test baseline 222 → 224.

32. **`001d547f`** — **feat(accounting,phase-4c-5): Piece B — wire TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS approval to Decision 5 dispatcher.** Replaces the Phase 4c.4 stub with real execution. Approval execution now replays the original POST request from the payload per ADR-003 Q2 design intent ("payloads must be self-sufficient... the request that arrived must be re-executable from the payload alone"). New "write_failed_replay" action enum value distinguishes "we tried but the underlying operation failed" from "we never tried" (stub_logged) and "we tried and it worked" (write_executed). Three outcomes handled: success → write_executed + upstreamResult; still-not-found → write_failed_replay; type-not-categorizable → write_failed_replay; unknown errors propagate. -1 stub test + 4 new tests = +3 net. Test baseline 224 → 227.

33. **`bfc8549d`** — **feat(accounting,phase-4c-5): Piece C — POST /transactions/:txnId/category route.** First Phase 4c.5 write endpoint shipped end-to-end. Validates URL+body params, assertCompanyAccess, withIdempotency wrapping (ADR-003 Q5 compliance), three response paths (200 success / 202 approval / 400 not categorizable). FK safety fix caught pre-commit: separated requestedByUserId/requestedByAgentId per actor type to prevent agent IDs being written to a users-FK field in production. New agent-actor test locks the FK separation (would have caught the bug if written first). +6 tests (5 originally planned + 1 agent-actor test from the FK fix). Test baseline 227 → 233.

**Decision 5 + Pieces A/B/C totals:**

10 commits across the day's continuation. +35 tests (198 → 233). The single-session arc establishes the same Path Y discipline that worked for Decision 4: per-type API verification before code, one focused change per commit, dedicated tests per code path. Path Y validated again — the FK bug caught pre-commit during Piece C is exactly the kind of issue that benefits from focused commits over batched ones.

**End-to-end paths now operational:**

1. **Direct programmatic caller** (e.g., internal services or future agents): `updateTransactionCategory(db, companyId, contactId, txnId, newAccountRef, hintedType?)` from `transaction-write.ts`.
2. **HTTP endpoint**: `POST /api/accounting/v1/transactions/:txnId/category` with full ADR-003 Q4 + Q5 compliance (202 pending-approval shape + idempotency replay support).
3. **Approval-replay path**: Approved `accounting.transaction.category_with_unknown_previous` rows trigger the dispatcher via `executeApprovedAccountingWrite`. Three execution outcomes via the new `write_failed_replay` action enum value.

**Architectural notes worth keeping:**

- Decision 5's asymmetry with Decision 4 (write covers 6 of 11 read types) is documented in-code AND in the WIP doc Decision 5 spec. Not an oversight; matches QBO/Xero API constraints.
- The shared-handler pattern (one handler / multiple registry keys) shipped for both reads (Decision 4 REVISED, Xero Invoice/Bill) AND writes (Decision 5, Xero Invoice/Bill). Mirrors actual API surface — same endpoint, Type discriminator on response.
- The FK safety fix during Piece C is a generalizable pattern worth remembering: when storing actor context to FK fields, always derive separately per actor type, NEVER unify via a single actorId variable. The latent bug existed because we treated logger context (which doesn't enforce FK) and approval-row context (which does) identically. Future write endpoints with approval-row creation should follow this pattern.

**Q5 newly pending:** Multi-line journal write semantics (QBO JournalEntry + Xero ManualJournal). Decision 5 explicitly excluded these because updating one line's AccountRef without offsetting changes breaks journal balance. The architectural problem (how does the caller express intent — preserve balance? update both lines? require dual-AccountRef?) needs its own decision.

**Q1 + Q2 — Charter status storage + Setup fee handling (third continuation of Session 4 work):**

After Decision 5 + Pieces A/B/C closed end-to-end, the session continued with the two architectural decisions that gated the Invoice endpoint — Q1 (Charter status storage) and Q2 (Setup fee handling). Both decisions had been documented as "pending" in ADR-003 Amendment 1 since 2026-05-24; both went through a lock-then-implement arc within a single session. 4 commits across the day's third continuation.

**Decision arc:**

Both Q1 and Q2 had three options each, documented in the WIP doc since the Decision 4 + Decision 5 work cleared the read/write dispatcher dependencies. Honest analysis surfaced the right path for each:

- **Q1 (Charter status storage):** Option B chosen — local DB table `client_charter_status`. Per Trust Tenet #14, billing is the primary client-funds touchpoint. Option B's status enum (`active` / `cancelled_was_charter` / `never_charter`) structurally enforces the EA Section 7.1 rules (especially "Charter is permanently lost on cancellation"). Option A (GHL custom field) was rejected because it puts GHL on the critical path for invoicing AND requires procedural-not-structural enforcement of the cancellation rule. Option C (compute from created_at + cutoff) was rejected because it's fundamentally incapable of modeling the cancelled-and-returned-forfeits-Charter rule.

- **Q2 (Setup fee handling):** Option B chosen — parallel `setup_fee_pricing` table. Setup fees don't vary by Charter status (EA Section 7), so they belong in their own table with no `isCharter` column. Aligns with Q1's design principle (each business concern gets its own table). Option A (extend service_tier_pricing with pricing_type discriminator) was rejected because it forces `isCharter` to be a meaningless column on setup_fee rows. Option C (separate endpoint entirely) was rejected as premature separation — setup fees ARE invoices structurally.

Both lock decisions went into the WIP doc in a single commit (Tenet #16 contract-before-code), mirroring the Decision 5 LOCKED pattern from earlier in the session.

**Commits shipped (Q1 + Q2 arc):**

34. **`0cf679d6`** — **docs(wip,phase-4c-5): LOCK Q1 (Charter status storage) + Q2 (Setup fee handling).** Pure docs, no code. Both decisions locked simultaneously: Q1 as Option B (local DB table), Q2 as Option B (parallel table). Full contract for each captured — schema columns, service function signatures, state-transition rules (Q1), seed values (Q2), Tenet rationale, options A/C rejected with reasoning. Per Tenet #16: locked contracts can be referenced by future implementation commits before any code lands.

35. **`5b4856bb`** — **feat(accounting,phase-4c-5): Q1 implementation — Charter status storage.** Single commit containing schema + migration + service + tests. New table `client_charter_status` (10 columns, unique constraint on companyId + ghlContactId). Service module `server/src/services/accounting/charter.ts` with public read API (`getCharterStatus`, `isCharterForInvoicing`) + mutation helpers (`grantCharterToNewClient`, `recordNonCharterClient`, `cancelCharter`) + 3 typed error classes. State-transition rules enforced at service layer: cancelled_was_charter is one-way (CharterTransitionError on attempted reverse), never_charter cannot be retroactively upgraded to active. Integration tests against embedded Postgres — 20 tests covering all read paths, all mutation helpers, default-to-never_charter behavior, scoping, and every FORBIDDEN state transition. Migration `0068_youthful_blockbuster.sql`. Tenet #7 verification of `service_tier_pricing.ts` during pre-implementation surfaced the tier-convention correction (display-style, not snake_case as the lock doc had) — Q1 doesn't use tier values but the verification prevented Q2 from inheriting the bad assumption. Test baseline 233 → 253 (+20).

36. **`83b80a72`** — **feat(accounting,phase-4c-5): Q2 implementation — Setup fee handling.** Single commit containing schema + migration + service + admin seed extension + tests. New table `setup_fee_pricing` (7 columns — NO isCharter, NO contactId per the lock). Service function `getSetupFeeCents` added to existing `pricing.ts` alongside `getExpectedPriceCents`. Admin endpoint POST /api/admin/pricing/seed extended to seed both tables in a single call. Sub-decision Q2-α-i locked during implementation: response shape changed from `{ data: { inserted, skipped, ... }, meta }` to `{ data: { pricing: {...}, setupFees: {...} }, meta }` to preserve per-table visibility (rejected Q2-α-ii summed-totals, which loses visibility; rejected Q2-α-iii separate endpoint, which contradicts the lock's "extend existing endpoint" mandate). 3 existing admin.test.ts tests required updates for the new nested response shape (expected per the locked sub-decision). 3 net new admin.test.ts tests added for the setup fee seeding behavior. Migration `0069_damp_bloodscream.sql`. Test baseline 253 → 262 (+9 net new: 6 in pricing.test.ts, 3 net new in admin.test.ts).

**Q1 + Q2 arc totals:**

3 commits across the day's third continuation. +29 tests (233 → 262). The arc demonstrates two patterns worth keeping:

1. **Tenet #16 contract-before-code in practice** — locking both decisions in docs first (commit 0cf679d6) before any implementation. Implementation commits (5b4856bb, 83b80a72) verified themselves against the locked contracts, surfaced two minor discrepancies (Q1's tier-convention correction; Q2's sub-decision Q2-α-i), and documented both in their commit messages for the doc closeout to fix.

2. **Pre-implementation Tenet #7 verification catches bugs at zero cost** — reading `service_tier_pricing.ts` BEFORE writing Q1's schema surfaced the tier-convention correction. If we'd written snake_case tier values (as the lock doc said) and shipped Q2's admin seed, three existing admin.test.ts tests would have broken AND Q2's seed values would have mismatched service_tier_pricing's display-style values, creating a silent data inconsistency. Five minutes of reading prevented hours of debugging.

**What's done vs deferred:**

DONE:
- Both schema migrations shipped (0068, 0069)
- Both service modules complete with full test coverage (charter.ts, pricing.ts extended)
- Admin seed endpoint extended (POST /api/admin/pricing/seed serves both tables in combined response)
- All locked contracts implemented per the WIP doc

DEFERRED (to follow-up sessions):
- Onboarding workflow integration (call site for grantCharterToNewClient / recordNonCharterClient based on the "first 10 paying clients" check)
- Cancellation workflow integration (call site for cancelCharter)
- Invoice endpoint wiring (POST /invoices will call both isCharterForInvoicing AND getSetupFeeCents)
- Production seed invocation (POST /api/admin/pricing/seed must be invoked on prod to populate the 3 new setup_fee_pricing rows — operational work, not code)

**Architectural notes worth keeping:**

- Both Q1 and Q2 went toward "separate, structurally-correct modeling" as a unified design principle. The codebase now has 4 pricing-related tables, each with a single clear responsibility: `service_tier_pricing` (recurring) / `setup_fee_pricing` (one-time) / `client_pricing_overrides` (per-client recurring overrides) / `client_charter_status` (charter lifecycle). The architecture rewards uniformity — when the Invoice endpoint is designed, each pricing concern has a known home.

- The Drizzle `pnpm generate` workflow pattern was used twice today (Q1 + Q2), validating memory #22. Schema-add sequence: write schema/*.ts → update index.ts → `cd packages/db && pnpm generate`. Each schema commit shows ~15k insertions because of the snapshot.json file (drizzle serializes the full schema state per migration); this is expected behavior, not a sign of unwanted changes. Migration numbers auto-increment per the registry, no manual bookkeeping needed.

- POST /invoices is now fully unblocked from architectural prerequisites. Only Q5 (multi-line journal write semantics) remains as a separate pending architectural decision, and Q5 does NOT gate Invoice or Payment endpoint work — it gates only category updates on journal-entry-type transactions, which can wait.

**Decision 6 — POST /payments scope (fourth continuation of Session 4 work):**

After Q1 + Q2 closeout, the session continued with Decision 6 — the second Phase 4c.5 write endpoint (POST /payments). What was originally documented as "POST /payments re-implementation: 2-3 hours (once thresholds + service signature fixes done)" turned out to be substantially larger work. The honest-scope correction surfaced during Tenet-#7 verification, locked Decision 6 with clear contracts, then shipped end-to-end in 5 commits across the same session.

**Decision arc:**

The work began with a sloppy initial scope assessment — I (the assistant) claimed "POST /payments is bigger than service signature fixes" by reading 50 lines of code and then jumped to enumerating four architectural Q-decisions. User pushback ("did you verify every assumption first?") was correct. After explicit Tenet #7 verification of all 6 assumptions (zero callers on the existing dispatcher; overloaded entityRef parameter; no threshold integration; no idempotency wiring; void return deviating from 17+ in-file conventions; established Decision 4/5 platform-inference pattern), the verified findings informed Decision 6's lock. Pattern worth keeping: verify BEFORE estimating, not after recommending.

Three Q-pay sub-decisions locked:

- **Q-pay-1 (Platform inference):** Service infers platform from accountingConnections lookup — matches Decision 4/5 pattern. Caller drops platform parameter.
- **Q-pay-2 (entityRef split):** Service signature splits the overloaded entityRef into typed `customerId?` + `accountId?` params; payload preserves entityRef per ADR-003 Q2. Route + replay both use the same `resolveEntityRefByPlatform` helper for translation.
- **Q-pay-3 (Audit-trail return):** Service returns `ReconcilePaymentResult` paralleling Decision 5's `UpdateTransactionCategoryResult`. Honors the 17+ in-file convention of capturing qboRequest/xeroRequest typed returns.

Q-pay-4 (threshold check at route layer) was settled by the existing `PaymentThresholdExceededPayload` shape — no decision needed. Q-pay-5 (approval-replay path) follows from Q-pay-1.

Two more sub-decisions surfaced DURING implementation and were locked separately (parallel to Decision 5's Q2-α-i pattern):

- **Q-pay-F-i (during Piece F):** Both helpers (`resolveEntityRefByPlatform` + `evaluatePaymentThreshold`) live in a single new file `payments-helpers.ts`. Not split; not in `thresholds.ts`; not in `index.ts`.
- **Q-pay-F-ii (during Piece F):** v1 ships without `expectedRange` in the payload. The optional field stays in the locked contract for future invoice-balance-comparison work, but `evaluatePaymentThreshold` returns only `thresholdAmount`.

**Commits shipped (Decision 6 arc):**

37. **`0924fb94`** — **docs(wip,phase-4c-5): LOCK Decision 6 — POST /payments scope (Q-pay-1 + Q-pay-2 + Q-pay-3).** Per Tenet #16 contract-before-code, Decision 6 locked in docs BEFORE any implementation. 6 assumptions verified at lock time; 3 Q-pay decisions documented with rejected alternatives. Pure docs.

38. **`37c55a08`** — **Piece D: Service refactor for reconcilePayment.** ReconcilePaymentResult interface + PaymentReferenceError class. Refactored both `qbo.applyPaymentToInvoice` and `xero.applyPaymentToInvoice` to capture platform-assigned paymentId via typed qboRequest/xeroRequest generics (QBO response shape `{ Payment: { Id, TxnDate? } }`, Xero response shape `{ Payments: Array<{ PaymentID }> }` — both verified via web research before code). Refactored `reconcilePayment` dispatcher: removed platform parameter (Q-pay-1), added accountingConnections lookup, validates ref split per Q-pay-2 with 4 distinct PaymentReferenceError reasons. 19 new tests in `reconcile-payment.test.ts`. Test baseline 262 → 281 (+19).

39. **`0d419021`** — **Piece F: Shared helpers — resolveEntityRefByPlatform + evaluatePaymentThreshold.** New file `payments-helpers.ts` per Q-pay-F-i. `resolveEntityRefByPlatform` performs the connection lookup + entityRef-to-split-ref translation. `evaluatePaymentThreshold` integrates the existing Phase 4c.2 `getMostSpecificThreshold` for the route handler's threshold check. Per Q-pay-F-ii, returns only `thresholdAmount` — expectedRange deferred. 16 new tests in `payments-helpers.test.ts`. Test baseline 281 → 297 (+16).

40. **`46f60b53`** — **Piece E: Approval-replay wiring for PAYMENT_THRESHOLD_EXCEEDED.** Replaced the Phase 4c.4 stub with real execution via `reconcilePayment` (Piece D) using `resolveEntityRefByPlatform` (Piece F). Three outcomes parallel to Piece B: success → write_executed; payload missing entityRef OR EntityRefResolutionError OR PaymentReferenceError → write_failed_replay; unknown errors propagate. 4 net tests in `write-approvals.test.ts` (-1 stub removed + 5 new). Test baseline 297 → 301 (+4).

41. **`41376751`** — **Piece G: POST /api/accounting/v1/payments route (FEATURE-COMPLETE).** Validates body (companyId, contactId, invoiceId, amount as positive integer cents, entityRef, optional paymentDate matching YYYY-MM-DD regex, optional reason). assertCompanyAccess. withIdempotency wrap with two-step work: threshold check (Piece F) → if exceeded, create approval row + 202; else, resolve + dispatch via Piece D + 200. Two domain-specific 400 codes (entity_ref_resolution_failed, payment_reference_invalid) for resolver/ref-validation failures. FK-safe actor separation per Piece C pattern. Sub-decision Q-pay-F-ii honored — payload omits expectedRange. 7 new tests in `accounting.test.ts` (including the agent-actor FK-separation test). Test baseline 301 → 308 (+7).

**Decision 6 arc totals:**

5 commits. +27 tests across the implementation arc (281 → 308). Per-commit ranges: 4-19. The arc demonstrates four patterns worth keeping:

1. **Lock-then-implement discipline (Tenet #16 contract-before-code):** Decision 6 locked first with full sub-decision rationale, then implementation across 4 pieces validated against the locked contract. Two new sub-decisions (Q-pay-F-i, Q-pay-F-ii) surfaced during implementation and were documented in commit messages for clean closeout — parallel to Decision 5's Q2-α-i pattern.

2. **Tenet #7 verification catches scope errors (and assumption-jumping):** The initial sloppy scope assessment ("POST /payments is bigger than service signature fixes") got correct pushback. After 6-assumption verification, the true scope was locked with grounded reasoning. The pattern "verify BEFORE estimating, not after recommending" is the right discipline.

3. **Single source of truth for translation logic:** `resolveEntityRefByPlatform` is used by BOTH the route handler (Piece G) AND the approval-replay path (Piece E). This was deliberately designed in Q-pay-2 + Piece F — identical translation guarantees identical behavior at both call sites. If a bug surfaces in translation, fixing it in one place fixes both.

4. **Path Y discipline validated (again):** One focused commit per concern. Piece D shipped the service layer alone; Piece F shipped helpers alone; Piece E shipped replay wiring alone; Piece G shipped the route alone. Each commit was small enough to verify in isolation. The agent-actor FK-separation test in Piece G's tests is a direct parallel to Piece C's same test — the pattern is now established and reused without re-deriving.

**End-to-end paths now operational for /payments:**

1. **Direct programmatic caller:** `reconcilePayment(db, companyId, contactId, invoiceId, amount, ref, paymentDate?)` from `services/accounting/index.ts`. Single canonical service-layer entry point.
2. **HTTP endpoint:** `POST /api/accounting/v1/payments` with full ADR-003 Q4 + Q5 compliance.
3. **Approval-replay path:** Approved `accounting.payment.threshold_exceeded` rows trigger `reconcilePayment` via the same `resolveEntityRefByPlatform` helper the route uses.

**Approval dispatcher wiring status after Piece E:**

| Type                                                         | Status            | Wired by                |
|--------------------------------------------------------------|-------------------|-------------------------|
| accounting.transaction.category_with_unknown_previous        | WIRED ✅           | Piece B (commit 001d547f) → Decision 5 |
| accounting.payment.threshold_exceeded                        | WIRED ✅ (this arc) | Piece E (commit 46f60b53) → Decision 6 |
| accounting.invoice.dedupe_ambiguous                          | STILL A STUB      | Awaits Invoice endpoint design |
| accounting.invoice.pricing_mismatch                          | STILL A STUB      | Awaits Invoice endpoint design |

**Architectural notes worth keeping:**

- Decision 6's "lock-then-implement" + "shared-resolver-between-route-and-replay" patterns are now established conventions for write endpoints in Phase 4c.5. Future endpoint work (POST /invoices) should follow the same shape.
- The Tenet #7 scope-correction pattern is worth internalizing: when initial estimates feel "small," verify the assumptions explicitly. The 6-assumption verification at Decision 6 lock time prevented a much larger downstream cost than the 5-10 minutes the verification took.
- POST /invoices is now the next-natural-step. It's architecturally unblocked (Q1 + Q2 prerequisites implemented), but the design itself requires fresh-session thinking: the request body needs to discriminate between recurring vs setup-fee invoices, validate against the right service function (getExpectedPriceCents vs getSetupFeeCents), and handle the two remaining approval types (invoice.dedupe_ambiguous + invoice.pricing_mismatch) — three things in one endpoint, not the cleaner one-thing-per-endpoint pattern Pieces C and G followed.

**State at session end (final after Decision 4 + Decision 5 + Pieces A/B/C + Q1 + Q2 + Decision 6 complete):**

- Codebase HEAD: master @ `41376751` (plus this docs commit pending)
- Test baseline: 308 targeted tests passing (+147 total across the day: +37 Decision 4 arc, +26 Decision 5 implementation, +9 Pieces A/B/C, +29 Q1 + Q2, +46 Decision 6 arc; baseline 161 at Session 3 start)
- Full monorepo typecheck: clean
- Phase 4c.5 status:
  - Defect 1: FIXED + prod-verified ✅
  - Decision 4 (read dispatcher): FEATURE-COMPLETE ✅
  - Decision 5 (write dispatcher — category): FEATURE-COMPLETE + INTEGRATED ✅
  - POST /transactions/:txnId/category route: SHIPPED end-to-end ✅
  - Q1 (Charter status storage): LOCKED + IMPLEMENTED ✅
  - Q2 (Setup fee handling): LOCKED + IMPLEMENTED ✅
  - Decision 6 (POST /payments scope): FEATURE-COMPLETE ✅
  - POST /payments route: SHIPPED end-to-end ✅
  - Q5 (multi-line journal write semantics): still pending (does not gate any endpoint)
- Phase 4c.5 endpoint roadmap:
  - POST /transactions/:txnId/category: SHIPPED ✅
  - POST /payments: SHIPPED ✅
  - POST /invoices: architecturally unblocked from Q1 + Q2 prerequisites; design work follows. Next step is fresh-session design (request body schema must discriminate between recurring vs setup-fee billing modes; wire to `getExpectedPriceCents` + `isCharterForInvoicing` for recurring, `getSetupFeeCents` for setup; the two remaining approval-dispatcher stubs — invoice.dedupe_ambiguous + invoice.pricing_mismatch — wire as part of this work).
- Approval dispatcher wiring status: 2 of 4 types WIRED (transaction-category + payment-threshold); 2 of 4 await Invoice endpoint
- Implementation gaps that are NOT architectural blockers (workflow integration for charter status, production seed invocation for setup fees) continue to be tracked in the WIP doc's "What is NOT implemented yet" subsections under Q1 and Q2

### Session 5 — 2026-05-28 (Thursday)

**Goal:** Design and ship POST /api/accounting/v1/invoices, the third and final Phase 4c.5 write endpoint, per the lock-then-implement discipline established by Decisions 5 and 6. On completion: 8 of 8 Phase 4 endpoints production-ready; 4 of 4 `executeApprovedAccountingWrite` approval-replay stubs wired.

**Decision arc:**

Decision 7 followed the Decision 6 shape — lock the contract first (Tenet #16 contract-before-code), implement as discrete Pieces, share helpers between the route handler and the approval-replay path. Pre-implementation Tenet #7 verification surfaced 3 findings that shaped the design before any code was written: (1) `findOrCreateCustomer` already performs dedupe detection via a 5-value `action` discriminant (3 unambiguous + 2 ambiguous), so the route does not reimplement dedupe; (2) `createInvoice` takes `lineItems` + `dueDate` directly and has NO `serviceTier` or pricing parameter, so pricing validation MUST live in the route, BEFORE the `createInvoice` call; (3) two distinct contactId semantics exist — the GHL contactId identifies *which client to bill* (used for pricing/charter/payload/audit) while the QBO books-connection key is always `null` for Ledgerix Pro's own-QBO global connection (used in `findOrCreateCustomer` + `createInvoice` calls). These findings drove the locked design.

The design lock (`a328db6f`) captured Option A: one decision, three sub-decisions Q-inv-1/2/3, single commit. Mid-implementation a contract gap surfaced — `InvoicePricingMismatchPayload` carries `customerName` + `customerEmail` but NOT a resolved `customerId` (unlike `InvoiceDedupeAmbiguousPayload` which does). Per the locked-decisions-stay-locked tenet, the Phase 4c.4 payload contract was not amended; instead Q-inv-3-β was REVISED (`7ac02b90`) with Option A: pricing_mismatch replay re-resolves the customer via `findOrCreateCustomer` before calling `createInvoice`; ambiguous-on-replay drift escalates to `write_failed_replay` (the human's pricing approval does NOT authorize resolving a fresh dedupe ambiguity). This is the conservative Trust-Tenet path. The asymmetry with the dedupe_ambiguous replay path (which uses the stored `matchedCustomerId` and does NOT re-resolve) is intentional and reflects the different payload shapes — documented in the REVISED note.

**Commits shipped (Decision 7 arc):**

42. **`a328db6f`** — **docs(wip): Decision 7 LOCKED — POST /invoices design (Q-inv-1/2/3 + sub-decisions).** Pure docs, no code. Per Tenet #16 contract-before-code, Decision 7 locked in WIP doc BEFORE any implementation. Three sub-decisions: Q-inv-1 explicit `billingMode` discriminator in request body (recurring → `getExpectedPriceCents`+`isCharterForInvoicing`; setup → `getSetupFeeCents`, no charter dimension per Q2); Q-inv-1-α — payload needs no `billingMode` field because an approved row is a human override and replay re-creates rather than re-validates. Q-inv-2 dedupe gate reuses `findOrCreateCustomer.action` with fixed heuristic confidence values (0.5 for `email_only_different_name`, 0.3 for `name_only`; Q-inv-2-α, honestly flagged as non-computed placeholders); Q-inv-2-β replay uses stored `matchedCustomerId`. Q-inv-3 pricing gate compares line-item total to expected at zero tolerance (Q-inv-3-α) because Ledgerix Pro owns both sides of the number; Q-inv-3-γ helper lives in new `invoices-helpers.ts`.

43. **`7ac02b90`** — **docs(wip): Decision 7 Q-inv-3-β REVISED — pricing_mismatch replay re-resolves customer (Option A).** Pure docs, no code. Implementation surfaced that `InvoicePricingMismatchPayload` carries no resolved `customerId`. Locked Phase 4c.4 contract not amended; pricing_mismatch replay re-resolves via `findOrCreateCustomer` (Option A). Ambiguous-on-replay drift escalates to `write_failed_replay` — the human's pricing approval does not authorize resolving a fresh dedupe ambiguity (conservative path). Intentional asymmetry with `dedupe_ambiguous` replay (which uses stored `matchedCustomerId` and does NOT re-resolve) documented — reflects different payload shapes, not a smell.

44. **`287bb180`** — **feat(accounting,phase-4c-5): Decision 7 Piece H — invoices-helpers (evaluateInvoicePricing + confidenceForMatchType).** New file `server/src/services/accounting/invoices-helpers.ts`. `evaluateInvoicePricing(sentAmountCents, expectedAmountCents)` returns `{ matches, deltaCents, deltaPercent }` — zero-tolerance per Q-inv-3-α (any non-zero delta → matches=false), with divide-by-zero guard returning `0%` when both are zero and `100%` when sent>0 and expected=0. `confidenceForMatchType(matchType)` maps the two ambiguous action values to the fixed heuristic confidences per Q-inv-2-α. Pure-logic module: no db, no I/O, no upstream calls. +8 tests in `invoices-helpers.test.ts` (test baseline 308 → 316).

45. **`441c8643`** — **feat(accounting,phase-4c-5): Decision 7 Piece I — wire invoice approval replay (dedupe_ambiguous + pricing_mismatch); dispatcher 4-of-4.** Replaced the two invoice approval stubs in `executeApprovedAccountingWrite` with real execution. `dedupe_ambiguous` replay uses stored `matchedCustomerId`, no re-resolve (Q-inv-2-β). `pricing_mismatch` replay re-resolves via `findOrCreateCustomer` (REVISED Q-inv-3-β Option A); ambiguous-on-replay drift escalates to `write_failed_replay` (conservative path). QBO books key `null` throughout (own-QBO global connection); GHL contactId used for audit context only. Removed 2 Phase 4c.4 stub tests, added 9 Piece I tests = +7 net. `executeApprovedAccountingWrite` now 4-of-4 approval types wired (transaction-category from Decision 5 + payment-threshold from Decision 6 + invoice-dedupe + invoice-pricing). Test baseline 316 → 323.

46. **`9366445d`** — **feat(accounting,phase-4c-5): Decision 7 Piece K — POST /api/accounting/v1/invoices route; Decision 7 FEATURE-COMPLETE.** Final Piece. Route flow: validate body → assertCompanyAccess → withIdempotency wrap → dedupe gate (Q-inv-2) → pricing gate (Q-inv-3) → createInvoice → 201. `billingMode` discriminator chooses pricing function per Q-inv-1. Two safety gates fire correctly: dedupe ambiguous → 202 with `accounting.invoice.dedupe_ambiguous` + heuristic confidence; pricing mismatch → 202 with `accounting.invoice.pricing_mismatch` + full audit fields. Two domain-specific 500 codes (`pricing_not_configured` + `setup_fee_not_configured`) for operational seeding gaps (NOT user-correctable 400s). FK-safe actor separation per Piece C/G pattern. Full ADR-003 Q5 idempotency. +17 tests (323 → 340). Piece J was a no-op — service-layer signatures already correct from Phase 4b.

47. **`ac58de83`** — **docs(ea): Decision 7 FEATURE-COMPLETE — POST /invoices shipped; §2B.4 REVISED; 8-of-8 endpoints.** EA closeout. Endpoint table row for `POST /api/accounting/v1/invoices` flipped from DEFERRED to Production-ready with full Decision 7 description. Count summary line updated from `6 of 8` to `8 of 8` endpoints production-ready. New Decision 7 entry added under "Architecture Decisions Made" as a sibling bullet to Decision 6 — captures Q-inv-1/2/3 + Q-inv-3-β REVISED + identifier seam + money convention + 5-commit implementation arc. The §2B.4 REVISED note (API Spec v1.0 "no automatic validation" / "billing agent is responsible" supersession) folded into the Decision 7 entry since the EA does not directly quote §2B.4 anywhere.

**Decision 7 arc totals:**

6 commits across the Session 5 day. +32 tests (308 → 340). The arc demonstrates four patterns worth keeping:

1. **Tenet #16 contract-before-code held again.** Two REVISED notes (Q-inv-3-β REVISED `7ac02b90` mid-implementation; §2B.4 REVISED in the EA closeout) — both shipped as deliberate doc-first revisions before/with the code that diverged from earlier language, NOT as silent adaptations after the fact. The pattern "lock the contract → if you find a gap, REVISE explicitly → then code" is now the default.

2. **Tenet #7 verification before locking continued to pay off.** The 3 pre-impl findings (findOrCreateCustomer already detects dedupe; createInvoice has no pricing param; two distinct contactId semantics) directly shaped the locked design. Without them, the natural-but-wrong design would have been to reimplement dedupe in the route OR add a pricing param to `createInvoice` — both would have been visible only at code-review time, much more expensive to undo than a 15-minute pre-impl read.

3. **Money convention worth recording as a doc-of-truth-now lesson.** The route uses **dollars in the request body and `lineItems[].amount`** (matches the existing `qbo.createInvoice` wire format and the already-shipped Piece I replay path), and **cents for all `*Cents`-suffixed pricing-decision / audit fields**. The conversion is **per-item rounding before summing** — `lineItems.reduce((acc, li) => acc + Math.round(li.amount * 100), 0)`, NOT `Math.round(sum * 100)`. Per-item rounding eliminates JS float-add accumulation error (`0.1 + 0.2 ≠ 0.3`) that under the locked exact-zero-tolerance comparison (Q-inv-3-α) would spuriously escalate valid multi-line invoices to HITL. Regression-locked with a divergent `[2.675, 2.675]` test (per-item 536¢ vs pre-round 535¢) — the test fails 201-vs-202 if the rounding order regresses. The test went through one iteration: the initial test used `[199.95, 99.99]` (a dataset where both rounding orders coincide), which would have passed even under a regression — corrected to the divergent `[2.675, 2.675]` dataset after explicit divergence-search via node REPL.

4. **Identifier seam worth recording.** The dual contactId semantics (GHL contactId for pricing/charter/payload/audit vs QBO books key always `null`) is the central design seam, parallel to Decision 6's Q-pay-2 overloaded-`entityRef` split. Both routes pass `null` as the QBO books key in their service calls; both use the *other* identifier (GHL contactId for invoices, the split typed `customerId?`/`accountId?` for payments) to reach the business-domain meaning. Future endpoints in Ledgerix Pro's own-QBO context should follow the same pattern.

**End-to-end paths now operational for /invoices:**

1. **Direct programmatic caller:** `qbo.createInvoice(db, companyId, /* QBO books key */ null, customerRef, lineItems, dueDate)` from `services/accounting/index.ts`. Same canonical entry point as before; what changed is the gating around it.
2. **HTTP endpoint:** `POST /api/accounting/v1/invoices` with full ADR-003 Q4 + Q5 compliance (validate → dedupe gate → pricing gate → createInvoice; 201 success / 202 approval / 400 validation / 500 unseeded-pricing).
3. **Approval-replay paths:** Approved `accounting.invoice.dedupe_ambiguous` rows replay via stored `matchedCustomerId`; approved `accounting.invoice.pricing_mismatch` rows re-resolve customer via `findOrCreateCustomer` (REVISED Q-inv-3-β Option A). Both via `executeApprovedAccountingWrite`.

**Approval dispatcher wiring status after Piece I:**

| Type                                                         | Status     | Wired by                |
|--------------------------------------------------------------|------------|-------------------------|
| accounting.transaction.category_with_unknown_previous        | WIRED ✅   | Piece B (commit 001d547f) → Decision 5 |
| accounting.payment.threshold_exceeded                        | WIRED ✅   | Piece E (commit 46f60b53) → Decision 6 |
| accounting.invoice.dedupe_ambiguous                          | WIRED ✅ (this arc) | Piece I (commit 441c8643) → Decision 7 |
| accounting.invoice.pricing_mismatch                          | WIRED ✅ (this arc) | Piece I (commit 441c8643) → Decision 7 |

**Phase 4c.5 closure:**

- **8 of 8 Phase 4 endpoints production-ready.** POST /transactions/:txnId/category (Decision 5), POST /payments (Decision 6), POST /invoices (Decision 7), plus the 5 read endpoints from Phase 4a/4b.
- **4 of 4 `executeApprovedAccountingWrite` stubs wired.** All four approval-replay paths land at real upstream writes.
- **Only Q5 (multi-line journal write semantics) remains pending in Phase 4c.5**, and it gates no endpoint. Q5 is about JournalEntry/ManualJournal category updates, which are currently routed to `TransactionTypeNotCategorizableError` via Decision 5's exclusion list — not a blocker for any business path.

**State at session end (final after Decision 7 complete):**

- Codebase HEAD: master @ `ac58de83` (plus this docs commit pending)
- Test baseline: 340 targeted tests passing (+32 across the Decision 7 arc)
- Full monorepo typecheck: clean
- Phase 4c.5 status:
  - Decision 4 (read dispatcher): FEATURE-COMPLETE ✅
  - Decision 5 (write dispatcher — category): FEATURE-COMPLETE + INTEGRATED ✅
  - POST /transactions/:txnId/category route: SHIPPED end-to-end ✅
  - Q1 (Charter status storage): LOCKED + IMPLEMENTED ✅
  - Q2 (Setup fee handling): LOCKED + IMPLEMENTED ✅
  - Decision 6 (POST /payments scope): FEATURE-COMPLETE ✅
  - POST /payments route: SHIPPED end-to-end ✅
  - Decision 7 (POST /invoices scope): FEATURE-COMPLETE ✅
  - POST /invoices route: SHIPPED end-to-end ✅
  - Q5 (multi-line journal write semantics): still pending (does not gate any endpoint)
- Phase 4c.5 endpoint roadmap: COMPLETE (8 of 8 production-ready)
- Approval dispatcher wiring status: 4 of 4 types WIRED (full coverage)
- Implementation gaps that are NOT architectural blockers (workflow integration for charter status, production seed invocation for setup fees) continue to be tracked in the WIP doc's "What is NOT implemented yet" subsections under Q1 and Q2

### Phase 4c.5 closeout — WIP-to-ADR migration (2026-05-28)

After Q5 LOCKED (commit `9cc3b6cd`) Phase 4c.5 had every architectural decision resolved (Decisions 1–7 + Q-charter + Q-setup-fee + Q-multi-line-journals), 8 of 8 endpoints production-ready, 4 of 4 approval-replay stubs wired, and 340 tests passing. The WIP doc's status of `ready_to_merge_to_adr` was finally accurate.

Per the `docs/wip/README.md` retirement convention ("all decisions locked + work shipped + tests passing → move the Architecture Decisions to an ADR, summarize the result in the relevant PHASE-N-PROGRESS.md, delete the WIP doc"), Phase 4c.5 became the first WIP doc to execute the full migration. Three sequential commits:

1. **ADR-004 drafted** (commit `e33bf8d3`). Peer ADR to ADR-003, capturing all 7 Decisions + 3 Q-items in canonical ADR form. Descriptive Q-labels (Q-charter, Q-setup-fee, Q-multi-line-journals) avoid collision with ADR-003's Q1–Q10. Two REVISED notes preserved (Decision 2 admin auth + Q-inv-3-β pricing replay) as the locked precedent for Tenet #16 doc-first revision discipline. Includes a Pre-implementation Tenet #7 finding section per Decision so future readers see the code grounding that shaped each lock. ADR-004 supersedes ADR-003's planning-level "Phase 4c.5: Re-ship the 3 write endpoints atop the safety layer" section.

2. **WIP doc archived** (commit `e45cd434`). `git mv` from `docs/wip/` to `docs/wip/archived/` to preserve rename history. Two factual errors corrected in the archival commit (per Scott's explicit confirmation: "correct it as part of the archival, not silently"): two references to a non-existent "top-level Q4 resolved during Decision 6" — the intended reference was to Q-pay-4, a sub-decision INSIDE Decision 6 about threshold check location. Top-level Q4 never existed; the Session-1 Q4 on admin auth resolved as Decision 2. Archival header added pointing readers at ADR-004 as the canonical decision record.

3. **PHASE-4-PROGRESS summary** (this commit). Closes the chronological arc with a forward-pointer to ADR-004.

**Canonical decision lookup, going forward:** ADR-004 is the authoritative source for Phase 4c.5 architectural decisions. PHASE-4-PROGRESS.md (this file) is the chronological diary — useful for "when did X ship?" and "what was the implementation arc?" but not the locked-decision contract. The archived WIP doc (`docs/wip/archived/phase-4c-5-write-endpoints-and-admin-api.md`) is preserved as historical narrative — useful for "what discarded options were considered?" and "how was X reached?" but the locked contract is in ADR-004.

**Architectural patterns established by Phase 4c.5** (captured canonically in ADR-004's "Architectural patterns" section): lock-then-implement workflow; Tenet #7 verify-before-locking; Tenet #16 REVISED-notes-doc-first; route↔replay shared helpers; FK actor separation; identifier-seam documentation when overloaded; money convention (dollars-in-body / cents-in-decision / per-item-rounding); honest deferral over speculative design (Q-multi-line-journals as the canonical Option C example).

**State at Phase 4c.5 close:**

- All Phase 4c.5 architectural decisions resolved.
- 8 of 8 Phase 4 endpoints production-ready; 4 of 4 approval-replay stubs wired.
- 340 accounting tests passing; typecheck clean.
- Open work tracked in ADR-004 § Open Items (operational/integration, not architectural): onboarding/cancellation workflow wiring for Q-charter, production seed for Q-setup-fee, consumer-agent identity for POST /api/accounting/v1/invoices against Decision 7's contract (agent identity deferred — see ADR-001 Phase 5+).
- HEAD master: this commit (post-migration).

**Commits shipped (migration arc):**

48. `e33bf8d3` — ADR-004 drafted (Phase 4c.5 write-endpoint implementation decisions, all 7 Decisions + 3 Q-items canonical).
49. `e45cd434` — WIP doc archived to `docs/wip/archived/` + two factual corrections folded in.
50. *this commit* — PHASE-4-PROGRESS Phase 4c.5 closeout summary (hash see `git log`; self-referencing hash inside the commit content is the chicken-and-egg case ADR-005-style commits would solve, deferred as not worth the amend cycle here).

### Phase 4c.5 operational follow-on — Q-setup-fee prod seed (2026-05-29)

Q-setup-fee operationally completed. The `setup_fee_pricing` admin seed endpoint (shipped Session 4 commit `83b80a72`) was invoked against Railway prod via the board API key after Phase 4c.5 architectural closure.

**Pre-flight + invocation:**
- Pre-flight unauth POST returned `HTTP 403 {"error":"Board access required"}` — confirmed endpoint mounted with auth guard intact.
- Authed POST with `pcp_board_railway_admin_key_2026` returned the version-aware Option D-modified idempotency response: `pricing.skipped: 6` (recurring already seeded from `104e82fb`), `setupFees.inserted: 3` (net-new). No supersedes, no inserts on the recurring side — confirms the idempotency model behaved as designed.

**Audit log verification (Railway prod psql):**
- Row id: `5ad4beea-0380-458a-afd2-369b16e89d17`
- `action`: `admin.pricing.seed`
- `entity_type`: `service_tier_pricing+setup_fee_pricing`
- `status`: `success`
- `actor_id`: `8h4TGtK2pquzYJ53TsnDpLHd9LibX4kv` (board user behind the Railway Admin Key)
- `details.pricing`: `{skipped: 6, inserted: 0, superseded: 0, newRows: 0, candidateCount: 6}`
- `details.setupFees`: `{skipped: 0, inserted: 3, superseded: 0, newRows: 0, candidateCount: 3}`
- `created_at`: `2026-05-29 03:22:42.967461+00`

**Outcome:**
- Setup-mode invoices (`billingMode: "setup"`) are now operational in prod. POST `/api/accounting/v1/invoices` will no longer return 500 `setup_fee_not_configured` for setup-mode calls.
- Q-setup-fee fully retired across architectural (Session 4 lock + implementation) AND operational (Session 5 follow-on prod seed) layers.

**Remaining Phase 4c.5 operational items** (per ADR-004 § Open Items):
- Q-charter — onboarding/cancellation workflow wiring (code work).
- Consumer-agent identity for POST /api/accounting/v1/invoices — reconciliation against Decision 7's contract (agent identity deferred per ADR-001 Phase 5+; now unblocked by this prod seed at infrastructure level).

**Commits shipped (operational follow-on):**

51. *this commit* — Q-setup-fee operationally retired; ADR-004 Open Items updated, PHASE-4-PROGRESS follow-on entry (hash see `git log`).

### Phase 4c.5 doc reconciliation — Billing & Invoicing agent naming deferred (2026-05-29)

Tenet #7 verification on the next-natural-step "Billing & Invoicing agent reconciliation" task surfaced that no such agent exists in code. The name appeared across ADR-004, the API spec, the Brief, the EA's Phase 4 narrative, and PHASE-4-PROGRESS — but `find server/src -type d -name "*agent*"` returned zero hits, and the EA's actual Phase 4 agent roster (AP Specialist, AR Specialist, Payroll) does not include a named "Billing & Invoicing" agent. The references were aspirational architectural intent ahead of agent infrastructure that hasn't shipped yet (ADR-001 Pattern B Full Phase 5+ work).

The naming question itself — which agent will own Ledgerix Pro's own monthly client billing, whether that's an AR-Specialist responsibility or a new dedicated agent — is genuinely undecided. Rather than rename to "AR Specialist agent" (which would silently answer the architectural question) or keep the named placeholder, the references were replaced with deferred-naming language pointing at ADR-001 Phase 5+ as the resolution context. Sub-option C ("defer the naming entirely") chosen per the decision-framing protocol.

**What changed (doc-only, no code):**
- ADR-004 § Open Items third bullet: rewritten to make the agent's non-existence explicit and the naming question deferred.
- ADR-004 + API spec + EA + Brief: occurrences of "Billing & Invoicing agent" replaced with the deferred-naming phrasing.
- The archived WIP doc (`docs/wip/archived/`) was deliberately NOT touched — it stays as historical record.

**What did NOT change:**
- The POST /api/accounting/v1/invoices endpoint contract is forward-compatible with whichever agent eventually consumes it. No endpoint changes.
- The EA's Phase 4 agent roster (AP Specialist, AR Specialist, Payroll) is the authoritative current state.
- Ledgerix Pro's own monthly billing remains a future-agent responsibility; no agent calls POST /invoices today.

**Commits shipped (doc reconciliation):**

52. *this commit* — Billing & Invoicing agent naming deferred across canonical docs (Sub-option C; hash see `git log`).

### Phase 4c.5 verify finding — Q-charter reframed as architectural arc (2026-05-29)

Tenet #7 verification on the remaining Phase 4c.5 open item ("Q-charter onboarding/cancellation workflow wiring") surfaced that the framing was wrong. What ADR-004 § Open Items called "code work" is actually a multi-session architectural arc with three undecided sub-questions: (1) which lifecycle event signals "became-paying" (no current dispatcher mapping covers this), (2) how to atomically enforce the first-10-Charter-clients cap (no count-of-active-Charter function exists in the service today), and (3) what triggers client cancellation (no cancellation handler exists in code at all). Same shape as today's earlier Billing & Invoicing finding — what looked like wiring against existing infrastructure turned out to be downstream of infrastructure that hasn't shipped.

**Decision per Sub-option B (close-the-finding, defer-the-arc):** ADR-004 § Open Items bullet rewritten to reflect the architectural-arc reality. The arc itself stays deferred to a future session that can give it focused attention — Trust Tenet's "default to conservative path on safety-adjacent work" applies; client lifecycle events affect billing pricing, so the decisions warrant fresh attention rather than tail-of-session execution.

**Pattern preserved (the third successful Tenet #7 save of the 2026-05-28/29 sessions):** the verify-before-acting discipline caught two false-positive "ready to implement" framings in 24 hours (Billing & Invoicing agent + Q-charter wiring). Both reduced to documentation honesty rather than premature code. Cost of the verify each time: ~15 min. Cost if we'd skipped: writing prompts against nonexistent entities.

**What did NOT change:**
- Charter service functions (`grantCharterToNewClient`, `recordNonCharterClient`, `cancelCharter`, `isCharterForInvoicing`) remain in code, fully tested, callable. No code regression.
- `isCharterForInvoicing` continues to default to `false` for unknown clients — Q-setup-fee's prod seed last session means invoice pricing now works correctly for the default-Standard path. The Charter-pricing path will activate when the arc lands.
- POST `/api/accounting/v1/invoices` continues to operate correctly for non-Charter clients (the only kind of client that currently exists in prod, since no Charter grants have been recorded).

**State at session end (full 2026-05-28/29 arc):**
- HEAD master @ (this commit).
- 340 accounting tests passing; typecheck clean.
- Phase 4c.5 architectural decisions: ALL resolved (Decisions 1–7 + Q-charter + Q-setup-fee + Q-multi-line-journals; the latter two as deferred-with-explicit-resolution; Q-charter now flipped to "architectural arc, deferred").
- Phase 4c.5 operational items: Q-setup-fee ✅ retired (prod seed 2026-05-29, audit-log `5ad4beea-...`); Q-charter reframed as architectural arc; consumer-agent identity deferred (Billing & Invoicing deferral).
- Phase 4c.5 itself is now genuinely closed across every dimension. Remaining work is either downstream of ADR-001 Phase 5+ (consumer agents, charter-lifecycle wiring) or fully outside Phase 4c.5's scope.

**Commits shipped (verify finding):**

53. *this commit* — Q-charter reframed as architectural arc; deferred-with-explicit-resolution (hash see `git log`).

### Next session (date TBD)

**Two paths forward, in any order:**

**Path A — Fix the compareAndSeed null-identity bug:** ✅ DONE Session 3 (commit `1727746a`, prod-verified via audit_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`). See 2026-05-26 Tuesday session entry above.

**Path B — Decision 4 implementation continues; Q1 + Q2 still pending:**

- ✅ **Q3 (get-transaction-by-id infrastructure scope)** — LOCKED Session 3 as Decision 4 (Option A — full coverage).
- ✅ **Decision 4 Phase 1** — SHIPPED Session 3 (commit `bffa3b16`). Dispatcher live; 3 of 11 types covered.
- ✅ **Decision 4 Phase 2 foundation** — SHIPPED Session 4 (commit `635e4998`). HttpResponseError + strict dispatcher discriminator.
- ✅ **Decision 4 Phase 2 type expansion** — SHIPPED Session 4 across 6 commits (`8830f206` JournalEntry, `7027c79a` Deposit, `2195544a` BillPayment, `769a39ca` Payment, `bf96d2d3` Invoice, `4e9d70be` Xero Invoice/Bill/ManualJournal). All 11 planned types now covered. Test baseline 161 → 198.
- ✅ **Decision 4 REVISED note** — SHIPPED Session 4 (commit `fb13f98c`). Documents the Xero shared-endpoint discovery per Tenet #16; revision landed BEFORE the divergent code commit.
- **POST /transactions/:txnId/category re-implementation** — now unblocked (~1-2 hours). The next-natural-step deliverable.
- Q1: Charter status storage (ADR-003 Amendment 1 Gap 1) — blocks Invoice endpoint. Entangled with business-model considerations.
- Q2: Setup fee handling (ADR-003 Amendment 1 Gap 2) — blocks Invoice endpoint. Entangled with business-model considerations.

**After both paths complete:**
- Re-implement the three write endpoints atop the now-complete safety layer
- Wire Phase 4c.4 dispatcher stubs to real upstream writes
- Final session: move locked decisions from Phase 4c.5 WIP doc to ADR-004, summarize in this tracker, update EA + Brief, delete the WIP doc

**Not in scope for the immediate-next session:**
- The three write endpoints themselves (Q1/Q2/Q3 need answers first)
- ADR-004 (created when all of Phase 4c.5 ships)
- EA v3.4 doc update (deferred until Phase 4c is more complete OR explicitly requested)
