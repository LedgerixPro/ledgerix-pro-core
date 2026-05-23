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

### Write endpoints (3) — Phase 4b
- [ ] `POST /api/accounting/v1/transactions/:txnId/category` — pending
- [ ] `POST /api/accounting/v1/payments` — pending (Idempotency-Key REQUIRED)
- [ ] `POST /api/accounting/v1/invoices` — pending (creates invoice in Ledgerix Pro's own QBO, not client books)

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

### 2026-05-24 Sunday (planned 12-14 hr)
**Goal:** Ship the 3 write endpoints (transaction category, payments, invoices)

**Plan:**
1. Build idempotency + audit log helper modules (with unit tests)
2. Build POST /transactions/:txnId/category route
3. Build POST /payments route
4. Build POST /invoices route (creates invoice in Ledgerix Pro's own QBO)
5. Service-level extension to reconcilePayment for paymentDate parameter
6. Build createInvoice service function

**Open architectural questions for Sunday:**
- Idempotency replay: does it write a NEW activity_log entry, or reference the original?
- Two-phase failure handling: precise rollback semantics when DB write succeeds but Xero/QBO write fails (or vice versa)?
- Whether to remove CashFlow from SupportedReportType union or document the Xero limitation differently

### 2026-05-25 Monday (Memorial Day, planned 12-14 hr)
- Continue write endpoints if not finished
- Integration testing
- Documentation updates (EA v3.4 reflecting Phase 4 completion)
- ADR-002 if remaining design decisions warrant
