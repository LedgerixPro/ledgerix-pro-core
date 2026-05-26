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

### Next session (date TBD)

**Two paths forward, in any order:**

**Path A — Fix the compareAndSeed null-identity bug:** ✅ DONE Session 3 (commit `1727746a`, prod-verified via audit_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`). See 2026-05-26 Tuesday session entry above.

**Path B — Resolve pending architecture questions, each in its own focused session:**

Recommended next: **Q3 first** — the most concretely scoped of the three (ADR-003 already identified Option A vs Option B; Option C was rejected). Scoping + decision lock estimated 3-5 hours; once locked, the Transaction Category endpoint becomes unblocked.

- **Q3: get-transaction-by-id infrastructure scope** — blocks Transaction Category endpoint. **Recommended next session.**
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
