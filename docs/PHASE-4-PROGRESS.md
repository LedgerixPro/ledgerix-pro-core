# Phase 4 — Accounting API Progress

**Started:** May 16, 2026 (commit 2f52a7f0)
**Active push:** May 23-30, 2026
**Goal:** All 8 endpoints production-ready with comprehensive test coverage
**Reference spec:** docs/PHASE-4-ACCOUNTING-API-SPEC.md
**Reference decision:** docs/adr/ADR-001-pattern-b-full-api-endpoints.md

## Endpoint Status (8 total)

### Read endpoints (5)
- [x] `GET /api/accounting/v1/transactions` — shipped May 16 (2f52a7f0), comprehensive tests added May 23 (8ed906d8)
- [ ] `GET /api/accounting/v1/bills` — pending
- [ ] `GET /api/accounting/v1/invoices` — pending
- [ ] `GET /api/accounting/v1/accounts` — pending
- [ ] `GET /api/accounting/v1/reports` — pending

### Write endpoints (3)
- [ ] `POST /api/accounting/v1/transactions/:txnId/category` — pending
- [ ] `POST /api/accounting/v1/payments` — pending
- [ ] `POST /api/accounting/v1/invoices` — pending

## Service Layer Functions
- [x] `getNewTransactions` — exists (supports `GET /transactions`)
- [x] `updateTransactionCategory` — exists (supports `POST /transactions/:txnId/category`)
- [x] `reconcilePayment` — exists (supports `POST /payments`)
- [ ] `getBills` — to build (for `GET /bills`)
- [ ] `getInvoices` — to build (for `GET /invoices`)
- [ ] `getAccounts` — to build (for `GET /accounts`)
- [ ] `getReports` — to build (for `GET /reports`)
- [ ] `createInvoice` — to build (for `POST /invoices`)

## Test Coverage Status
- [x] Vitest server-side infrastructure verified working (May 23, commit 8ed906d8)
- [x] Mocking pattern established (vi.mock + minimal Express test app + supertest)
- [x] Test helpers created (buildTestApp, localBoardActor in accounting.test.ts)
- [x] Comprehensive tests for `GET /transactions` — 15 test cases (May 23, 8ed906d8)
- [ ] Other endpoint tests: added as each endpoint ships

### Pattern established for future endpoint tests
- Mock service layer via vi.mock() (hoisted above route imports)
- buildTestApp(actorOverride) helper creates minimal Express app
- localBoardActor preset for tests not focused on auth
- Test categories: happy path, input validation, auth/authz, service errors, data handling
- Invocation: cd server && pnpm exec vitest run src/routes/accounting.test.ts

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
- 1 of 8 shipped, 7 remaining
- 5 service functions need building (in addition to 7 endpoints)
- Per-endpoint scope = service function + route + comprehensive tests
- Estimated 52-74 hours total for remaining work
- 7-day execution window: 56-72 hours availability
- Conclusion: Phase 4 can fully complete this week

## Session Log

### 2026-05-23 Saturday (8 hours planned)
- Hour 1: Setup (auth middleware review, tracker created) ✅
- Hour 2-2.5: Comprehensive tests for GET /transactions endpoint shipped (commit 8ed906d8, 15 test cases, 390 lines) ✅
- Hours 2.5-8: Bills endpoint (getBills service function + GET /bills route + tests) — in progress

#### Findings
- Server vitest.config.ts was bare (just environment:node) — no setup needed beyond what existed
- supertest and @types/supertest already installed
- No `test` script in server/package.json; invoke via `pnpm exec vitest run <file>`
- First failed assumption (Option B decision): instance admin does NOT bypass company access for reads.
  Documented in test comments. Behavior is intentional per Scott.

