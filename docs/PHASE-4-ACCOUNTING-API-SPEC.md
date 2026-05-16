# Phase 4 — Accounting API Design Specification

**Version:** 1.0
**Date:** May 16, 2026
**Author:** Scott Hansbury, Founder
**Status:** Approved — implementation specification for Phase 4b-h work

## Cross-references

- Strategic context for this work: `LEDGERIX-PRO-STRATEGIC-PLAN.md`
- Repository recovery procedures: `RESET.md` in repository root
- Per-agent operational instructions: `agents/{name}/AGENTS.md` files

---

## Section 1: Purpose, Scope, and Endpoints

### 1.1 Purpose

This document specifies the design for the Ledgerix Pro Accounting API — a versioned HTTP surface that exposes existing TypeScript accounting functions (`server/src/services/accounting/index.ts`) to runtime callers including AI agents, internal scripts, and future dashboard/admin tools.

It exists because of an architectural gap discovered on May 15, 2026: ten of Ledgerix Pro's eighteen agents reference TypeScript functions in their AGENTS.md instructions, but those functions are server-internal-only and not callable from the agent runtime. The AP Specialist hallucination incident on that date — where the agent generated five fake overdue bills after failing to find an invocation path for `qbo.getBills()` — was the first visible symptom. A subsequent audit (Phase 3b) confirmed nine other agents have the same broken pattern.

This API closes that gap and establishes the foundation for Ledgerix Pro's product architecture: AI-powered bookkeeping that works inside the client's existing QBO/Xero, keeping their books updated daily at a fraction of legacy bookkeeper cost. The endpoints designed here enable both the immediate goal (unbreak existing agents) and the planned near-term work (Categorization Rule Service + Active Categorizer, defined in Section 1.3 below).

For the strategic and business context that drove the architectural decisions in this document, see `LEDGERIX-PRO-STRATEGIC-PLAN.md`.

### 1.2 Strategic Context Summary

Ledgerix Pro is a lifestyle bootstrap business targeting 50 clients at maturity, generating ~$285k/year founder net income, requiring no more than 14 hours/week of operational founder time at steady state. The architecture supports this scale with a small operational team (founder + 1 US lead contractor + 1 offshore bookkeeper) and is deliberately not designed for hyper-growth or enterprise scale.

Key constraints driving Phase 4 decisions:
- All clients must use Xero or QuickBooks Online (no other accounting platforms supported)
- All clients use standardized industry-specific Charts of Accounts (per Strategic Plan)
- Founder time is precious; operational simplicity beats feature richness
- Audit trail and litigation defense matter — 7-year data retention policy applies to all writes
- Engineering investment is sequenced: Phase 4 (this work) → Phase 5 (HITL tooling) → Phase 6 (operator handoff) → Phase 7 (knowledge compounding)

See `LEDGERIX-PRO-STRATEGIC-PLAN.md` for full strategic context.

### 1.3 Scope

**In scope for v1:**
- 5 read endpoints (transactions, bills, invoices, accounts, reports)
- 3 write endpoints (transaction category, payment, invoice)
- Bearer-token authentication via the existing `actorMiddleware`
- Multi-tenant isolation via the existing `contactFilter` pattern
- Structured logging via the existing `pino` logger
- Audit logging for all write operations to the `activity_log` table
- Idempotency for write operations via `Idempotency-Key` header
- Vitest test coverage for each endpoint
- Aggregated read responses with a 5000-record safety cap (cursor pagination deliberately deferred)
- Versioning at `/api/accounting/v1/`

**Out of scope for v1 — intended near-term work (depends on this API):**

- **Categorization Rule Service.** AI analyzes a client's historical BankTransactions to recommend Bank Rules ("vendor X → category Y", "description contains 'AWS' → 'Cloud Infrastructure'"). Rules surface in the dashboard with a copy-paste-friendly view. A human Ledgerix operator adds them in the Xero UI during onboarding (~30 min per client). Xero's built-in rule engine then auto-applies them to incoming bank-feed items in real time. Estimated 1-2 weeks of work after this API ships.
- **Active Categorizer.** For items Xero's rules don't catch (15-30% of incoming items typically), the Ledger Specialist agent reads newly-posted BankTransactions via this API's read endpoints, decides categorization, and writes back via this API's `POST /transactions/:txnId/category` endpoint. Operates with a 1-3 day lag from when the bank feed posts. Estimated 4-6 weeks after the Rule Service ships.
- **HITL review tooling (Phase 5).** Operator-facing UI that minimizes time spent clearing flagged categorization decisions. Directly enables the team handoff at Stage 4.

Together, the Rule Service + Active Categorizer is the architectural direction for "daily-updated books." This API is their prerequisite foundation.

**Out of scope and not currently planned:**

- **Plaid integration.** Plaid solves "get bank data into your system." Ledgerix Pro's architecture works inside the client's existing QBO/Xero, which already has bank-feed connections. Plaid would only become relevant if Ledgerix Pro pivoted to running its own ledger (the Bench model). Not happening unless the product strategy changes.
- **Real-time bank-feed access.** Xero/QBO don't expose the pending categorization queue (Xero's "Reconcile" tab, QBO's "For Review" tab) via public API. The 1-3 day lag inherent in reading already-recorded transactions is accepted as a constraint for v1 and the lifestyle business model. Real-time options become considerations only if the lag proves insufficient at 50-client scale — which is unlikely.
- **Rate limiting.** Deferred to v2. `maxTurnsPerRun` provides the operational guard for now; no traffic data exists to set sane HTTP-level limits.
- **Caching.** Deferred to v2. No Redis infrastructure exists; current scale doesn't require it. Revisit when Anthropic API costs (currently ~10% of revenue at 50 clients) become a meaningful optimization target.
- **OpenAPI/Swagger documentation.** Nice-to-have, deferred to v2.
- **Webhook events for accounting changes.** No agent currently needs notifications on accounting changes; reads-on-cron is sufficient.
- **Enterprise features** (SSO, SCIM provisioning, multi-region deployment, advanced compliance certifications). Lifestyle business at 50 clients does not require these.
- **Annual prepay discounts.** Not offered. All clients on monthly billing.
- **Referral commissions.** Handled outside this system if implemented at all.

**Explicitly NOT solved by this API:**

- Reading items in the pending bank-feed categorization queue. Xero/QBO architectural constraint, not a Ledgerix Pro limitation. The Categorization Rule Service is the workaround: design rules upfront so Xero auto-categorizes most items in real time, then catch the rest with the Active Categorizer at 1-3 day lag.

### 1.4 Decisions Log

These decisions were made during Phase 4a recon and design discussion. They are binding for v1; revisiting requires explicit re-decision.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | URL versioning | `/api/accounting/v1/...` | Future v2 can ship without breaking agents. Sets clean precedent for the rest of the codebase. |
| 2 | Authentication | Bearer token via `actorMiddleware`. Each agent uses its own `agentApiKey`. | Per-agent attribution for debugging and audit. Existing infrastructure. Independent key rotation. |
| 3 | Rate limiting | Deferred to v2 | `maxTurnsPerRun` provides the operational guard. No traffic data yet. |
| 4 | Caching | Deferred to v2 | No Redis infrastructure. Revisit when API cost becomes optimization target. |
| 5 | Audit logging | All write endpoints log to `activity_log` automatically | Audit trail for regulated industry. Trust foundation for paying clients. Aligns with 7-year retention policy. |
| 6 | Idempotency | Write endpoints accept `Idempotency-Key` header. Same key within 24h returns original response. | Prevents double-application of payments / category updates from network-blip retries. |
| 7 | Response shape | `{ data: ..., meta?: ... }` envelope | Future-proof. Meta/links/errors fields can be added without breaking changes. |
| 8 | Pagination | Aggregated response with 5000-record safety cap | Simpler than cursor pagination. Xero pagination handled internally. Cap prevents runaway. |

**Decisions inherited from the existing codebase (per Phase 4a recon):**

| Item | Inherited Pattern |
|---|---|
| Route file shape | `export function accountingRoutes(db: Db) { const router = Router(); ...; return router; }` |
| Mount in app.ts | `api.use(accountingRoutes(db));` near line 285, alongside other Ledgerix routes |
| Multi-tenant isolation | Every handler passes `(db, companyId, contactId)` to existing helpers. The `contactFilter` in `xero-client.ts` and `qbo-client.ts` enforces row-level isolation at the OAuth connection layer. New SQL is not written against `accounting_connections`. |
| Error handling | Throw `badRequest()`, `unauthorized()`, `notFound()` from `server/src/errors.js`. The pino-http error middleware surfaces them with request context. |
| Logging | `logger` from `server/src/middleware/logger.js`. Structured objects. |
| Testing | Vitest. Co-located in `server/src/__tests__/`. CI runs `pnpm test:run` on every PR. |

### 1.5 Endpoint List

Eight endpoints total. Five reads, three writes. All under `/api/accounting/v1/`.

**Read endpoints (5):**

| Path | Function wrapped | Purpose | Unbreaks agents |
|---|---|---|---|
| `GET /api/accounting/v1/transactions` | `getNewTransactions` | Fetch transactions since a date for a client | Sentinel, Reconciliation, Payroll, Audit & Compliance |
| `GET /api/accounting/v1/bills` | `getBills` | Fetch open bills (non-zero balance) for a client | AP Specialist |
| `GET /api/accounting/v1/invoices` | `getInvoices` | Fetch open invoices (optionally filtered by customer/limit) | Reconciliation, AR Specialist |
| `GET /api/accounting/v1/accounts` | `getAccounts` | Fetch the chart of accounts for a client | Ledger Specialist |
| `GET /api/accounting/v1/reports` | `getProfitAndLoss` + `getBalanceSheet` | Fetch P&L or Balance Sheet for a date range | Tax Liaison |

**Write endpoints (3):**

| Path | Function wrapped | Purpose | Unbreaks agents |
|---|---|---|---|
| `POST /api/accounting/v1/transactions/:txnId/category` | `updateTransactionCategory` | Update a transaction's account category | Ledger Specialist, Senior Bookkeeper |
| `POST /api/accounting/v1/payments` | `reconcilePayment` | Apply a payment against an invoice | Reconciliation, Senior Bookkeeper |
| `POST /api/accounting/v1/invoices` | `findOrCreateCustomer` + `createInvoice` | Create an invoice in Ledgerix Pro's own QBO | Billing & Invoicing |

**Aggregate impact:** All 10 BROKEN agents from the Phase 3b audit gain a real data path. The endpoints additionally serve as the foundation for the Categorization Rule Service and Active Categorizer described in Section 1.3.

### 1.6 Implementation Order

To minimize risk and provide early wins, endpoints will be built in this sequence:

1. **Transactions endpoint first** — unbreaks the most agents (4) with one wrapper. Tests the auth, logging, multi-tenant patterns end-to-end. If something is wrong with the foundation, we discover it here, not in endpoint 8.
2. **Bills, Invoices, Accounts** (3 endpoints) — straightforward reads, similar shape to transactions.
3. **Reports** (P&L + Balance Sheet) — one endpoint with a `type` query parameter dispatching to two underlying functions.
4. **Write endpoints in order: transaction category, payment, invoice.** Writes are higher-risk; we ship them after reads are proven stable. Within writes, category-update is lowest-risk (single field on existing record), payment is medium (financial state change), invoice-create is highest (new record creation in Ledgerix Pro's own QBO).

Each endpoint is its own commit. Each commit ships with its tests passing. CI runs on every push.

---

## Section 2A: Read Endpoint Specifications

### 2A.1 Common patterns for all read endpoints

Every read endpoint follows the same skeleton. Specifying the common pattern once means each endpoint definition only documents what's unique.

#### Authentication

All endpoints require `Authorization: Bearer <agentApiKey>` header. Middleware: `actorMiddleware` (existing). The handler reads `req.actor` to identify the calling agent and log per-agent attribution.

Missing or invalid token: `401 Unauthorized` with `{ error: "Authentication required" }`.

#### Required query parameters

Every read endpoint requires:
- `companyId` — UUID of the Paperclip company (always `f60117de-1131-433c-934f-3fe88bfaa163` for Ledgerix Pro)
- `contactId` — GHL contact ID identifying the client whose books to query

Missing either: `400 Bad Request` with `{ error: "Missing required parameter: <name>" }`.

#### Authorization check

After auth, the handler verifies the agent has permission to access the specified `companyId`. Uses existing `assertCompanyAccess(req, companyId)` from `server/src/routes/authz.ts`.

Insufficient permission: `403 Forbidden` with `{ error: "Access denied for company" }`.

#### Multi-tenant isolation

The handler calls the underlying TS function (`xero.getTransactions`, `qbo.getBills`, etc.) passing `(db, companyId, contactId, ...)`. The existing `contactFilter` pattern in the OAuth-connection layer enforces isolation: the wrong contactId resolves to either a different OAuth row (different client's books) or no row at all (404). The handler does NOT write new SQL against `accounting_connections`.

If no accounting connection exists for the contact: `404 Not Found` with `{ error: "No accounting connection for contact" }`. Per Strategic Plan, this is treated as a data-integrity error — all Ledgerix Pro clients must have a connection.

#### Platform selection

For each contact, the system has either a Xero connection, a QBO connection, both, or neither. The endpoint resolves platform automatically:
- If exactly one platform connected: use it
- If both connected: use Xero (current preference)
- If neither: 404 with `code: "no_connection"` — treated as data-integrity error per Strategic Plan

The response includes `meta.platform` showing which one was used.

#### Response envelope

Successful responses always wrap data in `{ "data": <array or object>, "meta": { "platform": "xero" | "quickbooks", "fetchedAt": "<ISO 8601 timestamp>", "recordCount": <integer>, "truncated": <boolean> } }`.

`truncated: true` means the 5000-record safety cap was hit. The agent must treat truncated responses as incomplete data and choose to either narrow the query (e.g., shorter date range) or surface to HITL.

#### Error response envelope

All non-2xx responses use `{ "error": "<human-readable message>", "code": "<machine-readable code>", "details": <optional object with extra context> }`.

Standard codes:
- `auth_required` (401)
- `access_denied` (403)
- `missing_parameter` (400)
- `invalid_parameter` (400)
- `no_connection` (404)
- `upstream_error` (502 — Xero/QBO returned an error)
- `internal_error` (500 — code bug or unexpected state)

#### Logging

Every request logs structured fields: `actor.type`, `actor.id`, `companyId`, `contactId`, `endpoint` (path), `recordsReturned` (on success), `errorCode` (on failure), `latencyMs`.

Logs route to pino via existing logger. Authorization headers are auto-redacted.

#### Rate limiting

None in v1. Deferred to v2 per Section 1.4 decision #3.

### 2A.2 GET /api/accounting/v1/transactions

**Purpose:** Fetch transactions (BankTransactions on Xero; Purchase + Deposit + Transfer on QBO) that have been recorded since a given date for a specific client. Replaces direct calls to `getNewTransactions(db, companyId, contactId, sinceDate)`.

**Query parameters:**

| Parameter | Type | Required | Validation | Default |
|---|---|---|---|---|
| `companyId` | UUID string | Yes | — | — |
| `contactId` | string (GHL contact ID) | Yes | — | — |
| `since` | ISO 8601 date (YYYY-MM-DD) | Yes | Must parse as valid date; must not be in the future | — |
| `platform` | "xero" or "quickbooks" | No | Must match a connected platform for the contact | Auto-select |

**Response (200 OK):** JSON envelope with `data` array of transaction objects (fields: `id`, `type`, `date`, `amount`, `vendor`, `accountRef`, `description`, `isReconciled`, `status`) and `meta` object with `platform`, `fetchedAt`, `recordCount`, `truncated`, `since`.

**Important field semantics:**

- **`isReconciled`** is the field added in commit `031e8c8c`. For Xero it reflects `IsReconciled` from the BankTransaction response. For QBO it is always `null` (QBO has no equivalent concept on Purchase/Deposit/Transfer entities). Agents using this endpoint to identify "still in the pending queue" transactions should know: **`isReconciled: false` does NOT mean the transaction is in Xero's Reconcile tab.** Xero's pending queue is bank statement lines, not BankTransactions. By the time a BankTransaction exists, it has already been recorded. The `isReconciled` flag indicates whether that recorded transaction has been matched to a bank statement line, not whether categorization is pending.
- **`status`** is the platform-native status string (Xero: `AUTHORISED`, `DELETED`, `VOIDED`; QBO: `null`). Agents should treat `DELETED` and `VOIDED` as records to skip.
- **`accountRef`** is the COA account the transaction has been categorized to. `null` means uncategorized. For the Active Categorizer use case, this is the field that indicates whether categorization work is needed.

**Special cases:**

- **No transactions match:** `200 OK` with `data: []`, `meta.recordCount: 0`. NOT an error.
- **Truncation hit:** Response includes data array (up to 5000 records) plus `meta.truncated: true`. Agent should re-query with a narrower `since` to drain remaining records, or escalate to HITL.
- **`since` in the future:** `400 Bad Request` with `code: "invalid_parameter"` and details indicating the rejected value.
- **`since` too far in the past (>2 years):** Allowed, but may hit truncation. Agent should consider chunking.

### 2A.3 GET /api/accounting/v1/bills

**Purpose:** Fetch open bills with non-zero balance for a specific client. Replaces direct calls to `getBills(db, companyId, contactId)`. This is the endpoint AP Specialist needs.

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Response (200 OK):** JSON envelope with `data` array of bill objects (fields: `id`, `vendorName`, `amount`, `balance`, `dueDate`, `daysDue`) and standard meta.

**Important field semantics:**

- **`balance`** is what's still owed. `amount` is the original bill total.
- **`daysDue`** is signed: `7` = due in 7 days, `-3` = overdue by 3 days. Agents use this for the 7-day-warning / overdue / seriously-overdue classifications in AP Specialist's flow.
- **Only non-zero-balance bills are returned.** Paid-off bills are excluded by the underlying function.

**Special cases:**

- **No open bills:** `200 OK` with `data: []`. This is the case where AP Specialist hallucinated 5 fake bills on 2026-05-15. The agent's playbook-rewritten prompt must produce no email output in this case.
- **Vendor name missing:** Some bills may have an empty `vendorName` string. Agent must handle this case explicitly — do not invent a vendor name to satisfy a template.

### 2A.4 GET /api/accounting/v1/invoices

**Purpose:** Fetch open invoices for a specific client. Supports optional filtering by customer for AR Specialist's "last 12 invoices for this customer" pattern.

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `customerId` | string | No | All customers |
| `limit` | integer (1-100) | No | All matching |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Response (200 OK):** JSON envelope with `data` array of invoice objects (fields: `id`, `customerName`, `customerId`, `invoiceNumber`, `amount`, `balance`, `dueDate`, `issueDate`, `daysDue`, `status`) and `meta` including optional `filtered` sub-object showing applied filters.

**Note:** The underlying `getInvoices` function signature may need extension to accept the `customerId` / `limit` options. This will be flagged during Phase 4b implementation.

**Special cases:**

- **`customerId` doesn't exist:** `200 OK` with `data: []`. NOT a 404.
- **`limit` requested but fewer records exist:** Returns all matching records. `meta.recordCount` reflects actual count.

### 2A.5 GET /api/accounting/v1/accounts

**Purpose:** Fetch the chart of accounts for a specific client. Used by Ledger Specialist for categorization decisions.

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Response (200 OK):** JSON envelope with `data` array of account objects (fields: `id`, `name`, `code`, `type`, `subType`, `active`) and standard meta.

**Special cases:**

- **Inactive accounts:** Included in response with `active: false`. Agents should filter to `active: true` for categorization decisions.
- **Chart of accounts is typically stable** — strong candidate for caching in v2.

### 2A.6 GET /api/accounting/v1/reports

**Purpose:** Fetch financial reports (P&L or Balance Sheet) for a specific client and date range. Used by Tax Liaison and Reporter.

**Status:** Response shape marked as TBD during Phase 4b implementation. The exact normalization of Xero/QBO report responses requires investigation during the build. The high-level concept is locked; specific field structures will be refined during Phase 4b.

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `type` | "pnl" or "balance-sheet" | Yes | — |
| `from` | ISO 8601 date | Yes for pnl; Optional for balance-sheet | — |
| `to` | ISO 8601 date | Yes | — |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Response shape (preliminary — finalize during Phase 4b):**

P&L response data contains: `reportType: "pnl"`, `periodStart`, `periodEnd`, `currency`, `totalRevenue`, `totalExpenses`, `netIncome`, `lineItems` array (each with `section` of revenue/expense/other, `accountName`, `amount`).

Balance Sheet response data contains: `reportType: "balance-sheet"`, `asOfDate`, `currency`, `totalAssets`, `totalLiabilities`, `totalEquity`, `lineItems` array (each with `section` of asset/liability/equity, `accountName`, `amount`).

**Special cases:**

- **Date range with no transactions:** Returns zeros for all aggregates, empty `lineItems` array. NOT an error.
- **Balance sheet without `from`:** Uses platform default (typically inception-to-date).

---

## Section 2B: Write Endpoint Specifications

### 2B.1 Common patterns for all write endpoints

All write endpoints inherit the read endpoint common patterns from Section 2A. The following additions apply specifically to writes:

#### Idempotency

Every write endpoint accepts an `Idempotency-Key` HTTP header:

- **Required:** No (except `POST /payments` which REQUIRES it — see 2B.3)
- **Format:** Any string up to 255 characters. UUID v4 recommended.
- **Window:** 24 hours from first use.
- **On duplicate key within window:** The original response is returned with HTTP status `200 OK` (read-only replay). Response includes `meta.idempotencyReplay: true`.
- **On duplicate key with different request body:** Returns `409 Conflict` with `code: "idempotency_conflict"`.

A new `idempotency_keys` table tracks `(company_id, key, request_hash, response_body, response_status, created_at, expires_at)`. The migration is part of Phase 4b implementation.

#### Audit logging

Every write attempt (success or failure) generates an entry in the existing `activity_log` table. This is the litigation-defense foundation referenced in the Strategic Plan's 7-year retention policy.

The `activity_log` table will be extended with a `status` field (`success` or `failure`).

**Entry contents captured:** actor_type, actor_id, actor_name, company_id, contact_id, platform, endpoint (full path + method), entity_type (transaction/payment/invoice), entity_id, before (prior state if applicable), after (new state if successful), idempotency_key (if provided), idempotency_replay (boolean), status (success or failure), error_code (when failed), error_message (sanitized, when failed), reason (optional from request body), timestamp (ISO 8601).

#### Two-phase failure handling

1. **Pre-call failure** — validation, auth, or connection lookup fails before we call Xero/QBO. Return appropriate 4xx with no upstream effect.
2. **Upstream failure** — Xero/QBO returns an error. Return `502 Bad Gateway` with `code: "upstream_error"`. The activity_log entry IS written with `status: "failure"`.

#### Response envelope for writes

Standard write response envelope: `data` contains the updated or created entity; `meta` contains `platform`, `performedAt` (ISO 8601), optional `idempotencyReplay` (boolean, omitted if false), and `auditLogId` (UUID of the activity_log entry).

### 2B.2 POST /api/accounting/v1/transactions/:txnId/category

**Purpose:** Update the chart-of-accounts category of an existing transaction. Used by Ledger Specialist (for newly-posted transactions that didn't match a Bank Rule) and Senior Bookkeeper (when approving HITL-flagged categorization decisions).

This is the workhorse endpoint for the Active Categorizer architecture.

**Path parameter:** `txnId` (string, platform-specific transaction ID)

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Request body:** JSON object with `accountRef` (string, required — account code or name in the client's chart of accounts) and `reason` (string, optional — agent-provided rationale for the categorization).

**Important field semantics:**

- **`accountRef`**: Must match an existing account in the client's chart of accounts. The endpoint relies on upstream Xero/QBO validation rather than pre-calling `getAccounts`.
- **`reason`**: Captured in the audit log entry. Useful for explaining categorization decisions in future disputes. Not required, but strongly encouraged for agent-driven calls.

**Response (200 OK):** Standard write envelope. `data` contains `id` (transaction ID), `previousAccountRef`, `newAccountRef`, `platform`.

**Special cases:**

- **`accountRef` is invalid:** Upstream returns error. Response is `502 Bad Gateway`.
- **Transaction doesn't exist:** Upstream returns 404. Response is `404 Not Found` with `code: "entity_not_found"`.
- **Transaction was deleted/voided:** Response includes `meta.warning` and the audit log notes the unusual update.
- **Same categorization already set:** Platform-dependent behavior; passed through.

### 2B.3 POST /api/accounting/v1/payments

**Purpose:** Apply a payment against an existing invoice in a client's books. Used by Reconciliation Agent and Senior Bookkeeper.

This is the highest-stakes write endpoint. **Idempotency-Key is REQUIRED.**

**Query parameters:**

| Parameter | Type | Required | Default |
|---|---|---|---|
| `companyId` | UUID string | Yes | — |
| `contactId` | string | Yes | — |
| `platform` | "xero" or "quickbooks" | No | Auto-select |

**Required header:** `Idempotency-Key: <unique string>`. Missing header returns `400 Bad Request` with `code: "missing_idempotency_key"`.

**Request body:** JSON object with `invoiceId` (string, required), `amount` (number, positive, required), `paymentDate` (ISO 8601 date, optional, defaults to today), `entityRef` (string, optional — customer or bank account reference), `reason` (string, optional).

**Important field semantics:**

- **`invoiceId`**: Must reference an existing open invoice. Endpoint relies on upstream validation.
- **`amount`**: Must be positive. Some platforms reject overpayments; behavior passes through.
- **`paymentDate`**: Defaults to today. Cannot be in the future. Cannot be more than 5 years in the past.
- **`entityRef`**: Optional context. Captured in audit log.

**Response (200 OK):** Standard write envelope. `data` contains `paymentId`, `invoiceId`, `amountApplied`, `remainingBalance`, `invoiceStatus`.

**Special cases:**

- **Invoice doesn't exist:** `404 Not Found` with `code: "entity_not_found"`.
- **Invoice already fully paid:** Platform-specific behavior, passed through. May create credit balance.
- **Payment amount exceeds outstanding balance:** Platform-specific, passed through.
- **Payment date in the future:** `400 Bad Request` with `code: "invalid_parameter"`.
- **Duplicate payment via same Idempotency-Key:** Returns the original response (replay).

**Note:** The underlying `reconcilePayment` function signature may need extension to accept the optional `paymentDate` parameter. Flagged during Phase 4b implementation.

### 2B.4 POST /api/accounting/v1/invoices

**Purpose:** Create a new invoice in **Ledgerix Pro's own QBO** (not in client's books). Used exclusively by the Billing & Invoicing agent for monthly Ledgerix Pro service billing.

This endpoint operates on Ledgerix Pro's own QBO, not on client books. The `contactId` parameter identifies which Ledgerix Pro client to invoice, but the invoice itself is created in Ledgerix Pro LLC's QBO account.

**Query parameters:**

| Parameter | Type | Required | Validation |
|---|---|---|---|
| `companyId` | UUID string | Yes | Always Ledgerix Pro's UUID |
| `contactId` | string | Yes | The Ledgerix Pro client to bill |

The `platform` parameter is NOT accepted. Ledgerix Pro's own books are exclusively on QBO.

**Request body:** JSON object with `customerName` (string, required), `customerEmail` (string, required), `serviceTier` (one of: Foundation, Growth Engine, Scale-Up), `billingPeriod` (object with `start` and `end` ISO 8601 dates), `lineItems` (array of objects with `description` string and `amount` positive number), `dueDate` (ISO 8601 date, optional, defaults to Net 15), `reason` (string, optional).

**Response (201 Created):** Standard write envelope. `data` contains `invoiceId` (QBO invoice ID), `invoiceNumber`, `customerId` (QBO customer ID), `totalAmount`, `dueDate`, `status`.

**Special cases:**

- **Customer already exists:** `findOrCreateCustomer` reuses the existing customer record.
- **Customer email doesn't match existing record but name does:** A new customer is created. May result in duplicates if naming is inconsistent. Audit log captures the decision.
- **Duplicate invoice via Idempotency-Key:** Returns the original response (replay).
- **Service tier doesn't match expected pricing:** No automatic validation. The billing agent is responsible. Audit log captures whatever was sent.

**Note:** Implementation passes `contactId: null` to underlying QBO functions because Ledgerix Pro's own QBO uses the legacy global connection pattern. This mixing of patterns is acceptable for v1; refactor deferred.

---

## Section 3: Cross-Cutting Concerns

### 3.1 Authentication

#### Pattern

All endpoints under `/api/accounting/v1/*` require Bearer token authentication via the existing `actorMiddleware`. The middleware identifies the calling agent or human via their API key, populates `req.actor`, and rejects unauthenticated requests.

#### Token types accepted

| Token type | Stored in | Use case |
|---|---|---|
| `agentApiKey` | `agent_api_keys` table | Agent runtime calls — each agent has its own key |
| `boardApiKey` | `board_api_keys` table | Human user calls (Scott, future operators, debugging tools) |

Both token types pass through `actorMiddleware` identically. The handler inspects `req.actor.type` (`"agent"` or `"board"`) to identify which type was used, primarily for audit logging.

#### Token validation

The middleware hashes the provided token (SHA-256) and looks up the hash in the appropriate table. Tokens are never stored in plaintext. Token rotation requires generating a new token, updating the database, and updating the caller's stored token — there is no in-place rotation mechanism in v1.

#### Required header

`Authorization: Bearer <token>`

#### Failure modes

| Condition | Response |
|---|---|
| Missing `Authorization` header | `401 Unauthorized` with `code: "auth_required"` |
| Malformed header (not `Bearer ...`) | `401 Unauthorized` with `code: "auth_invalid_format"` |
| Token doesn't match any known key | `401 Unauthorized` with `code: "auth_invalid_token"` |
| Token revoked or expired | `401 Unauthorized` with `code: "auth_revoked"` |

#### Authorization (beyond authentication)

Authentication confirms WHO is calling. Authorization confirms WHAT they can call. For accounting endpoints, the authorization check is `assertCompanyAccess(req, companyId)` — confirms the authenticated actor has access to the specified Paperclip company. Existing helper from `server/src/routes/authz.ts`.

For Ledgerix Pro's single-company architecture, this check is mostly a sanity guard against misconfigured agents trying to call the wrong company's data. With one company, it always passes for any properly-authenticated Ledgerix Pro agent. The check matters at the architectural level even if it's a no-op in practice.

Failure mode: Authenticated actor lacks access to specified `companyId` returns `403 Forbidden` with `code: "access_denied"`.

#### Logging

Every request logs: `actor.type` ("agent" or "board" or "user"), `actor.id` (UUID), `actor.name` (resolved name).

Auth tokens are never logged. The pino logger's existing redaction list automatically strips `req.headers.authorization`.

### 3.2 Multi-Tenant Isolation

#### Pattern

Multi-tenant isolation in Ledgerix Pro is enforced at the OAuth-connection layer, not at the application layer. Every accounting helper function takes `(db, companyId, contactId, ...)` and uses `contactFilter(contactId)` to constrain the OAuth connection lookup. The OAuth tokens themselves are bound to specific Xero tenants or QBO realms.

**Critical property: isolation is fail-safe.** A bug in the query (e.g., forgetting the `contactId` filter) wouldn't leak Client A's data through Client B's tokens — it would call the wrong Xero tenant entirely using the wrong tokens, resulting in either a 401 (tokens don't match the tenant) or no data found. The architecture cannot produce "wrong client's data via right tokens" failures.

#### Rules for new code in the accounting routes

These rules are binding for any handler in `accountingRoutes`:

1. **Every accounting operation MUST be routed through an existing accounting helper.** Direct queries against `accounting_connections` are prohibited. The helpers (`xero.getBills`, `qbo.getTransactions`, etc.) own the contactFilter logic and must continue to.
2. **The `contactId` parameter MUST be propagated to the helper unmodified.** Don't strip, transform, or default it. If the caller provided `contactId`, it goes to the helper as-is. If the caller didn't provide it, the endpoint returns 400 before any helper is called.
3. **Never assume "single tenant" optimizations.** Even though Ledgerix Pro has one Paperclip company, the per-contact isolation matters because each contact has its own OAuth connection. Don't add code that shortcuts this.
4. **Cross-contact reads are not supported in v1.** A handler cannot aggregate data across multiple contacts in a single response. If aggregation is needed (e.g., "all clients' total revenue"), the caller makes N separate requests. Internal aggregation crosses tenant boundaries and creates risk we don't want.

#### Failure modes specific to isolation

| Condition | Response |
|---|---|
| `contactId` not provided | `400 Bad Request` with `code: "missing_parameter"` |
| `contactId` provided but no accounting_connections row exists | `404 Not Found` with `code: "no_connection"`. Treated as a data-integrity error |
| OAuth tokens expired and refresh failed | `502 Bad Gateway` with `code: "upstream_auth_failure"`. Indicates need for OAuth re-authorization |

#### Logging

Every request logs: `companyId`, `contactId`, `platform` (resolved during platform selection). Together these form the tenant identity that lets us audit "what data did we access for which client."

### 3.3 Error Handling

#### Pattern

The accounting routes throw errors using existing helpers from `server/src/errors.js`:

| Helper | HTTP Status | Use case |
|---|---|---|
| `badRequest(message, details)` | 400 | Invalid input from caller |
| `unauthorized(message)` | 401 | Authentication failure |
| `forbidden(message)` | 403 | Authorization failure (authenticated but not allowed) |
| `notFound(message, details)` | 404 | Resource doesn't exist |
| `conflict(message, details)` | 409 | State conflict (e.g., idempotency-key conflict) |
| `internalError(message)` | 500 | Unexpected error |
| `badGateway(message, details)` | 502 | Upstream Xero/QBO error |

The pino-http error middleware catches these, formats them into the response envelope, and logs them with request context.

#### Code values (full enumeration)

| Code | Status | Meaning |
|---|---|---|
| `auth_required` | 401 | No `Authorization` header provided |
| `auth_invalid_format` | 401 | `Authorization` header not in `Bearer ...` format |
| `auth_invalid_token` | 401 | Token doesn't match any known key |
| `auth_revoked` | 401 | Token was previously valid but has been revoked |
| `access_denied` | 403 | Authenticated actor lacks access to the specified company |
| `missing_parameter` | 400 | Required query parameter not provided. `details.parameter` names the missing one |
| `invalid_parameter` | 400 | Parameter value failed validation. `details.parameter` and `details.reason` |
| `invalid_body` | 400 | Request body failed validation. `details.errors` array |
| `missing_idempotency_key` | 400 | Required Idempotency-Key header not provided on `/payments` |
| `no_connection` | 404 | No accounting connection exists for the contact |
| `entity_not_found` | 404 | The specified transaction/invoice/account doesn't exist in the upstream platform |
| `idempotency_conflict` | 409 | Same Idempotency-Key arrived with different body |
| `upstream_error` | 502 | Xero/QBO returned an error |
| `upstream_auth_failure` | 502 | OAuth token refresh failed |
| `upstream_timeout` | 504 | Xero/QBO request timed out |
| `internal_error` | 500 | Unexpected error (bug or unhandled state) |

#### Error logging levels

- **400 / 404 / 409:** `warn` level. Caller errors; don't indicate Ledgerix Pro is broken.
- **401 / 403:** `warn` level. Repeated 401s for a specific token might indicate compromise — worth alerting on at scale, but v1 just logs.
- **500:** `error` level. Bugs that need fixing.
- **502 / 504:** `error` level. Upstream issues. May indicate Xero/QBO outages or specific tenant issues.

All error logs include the full request context (sanitized — no tokens or sensitive body fields).

#### What the agent caller does with errors

Agent prompts will be rewritten in Phase 4f to handle the error codes consistently. The Anti-Hallucination Playbook's Pattern 3 ("Vocabulary for 'No Work to Do'") applies:

- **Soft failures** (`no_connection`, `entity_not_found`, empty result on a read): agent sets `Status: blocked` with reason, exits cleanly. No hallucination.
- **Auth failures** (`auth_*`, `access_denied`): agent escalates to founder. These indicate system misconfiguration, not transient issues.
- **Caller errors** (`missing_parameter`, `invalid_parameter`, `invalid_body`): agent treats as bug in its own prompt. Logs context, escalates.
- **Upstream errors** (`upstream_*`): agent may retry with backoff, but the Idempotency-Key ensures retries are safe. After 3 retries with backoff, escalate.

### 3.4 Idempotency

#### Pattern

Write endpoints accept an `Idempotency-Key` HTTP header. The endpoint behavior depends on whether the key has been seen before within a 24-hour window:

1. **First time the key is seen:** Process the write normally. Store the request hash, response body, and response status in the `idempotency_keys` table.
2. **Same key, same request body (within 24h):** Replay the original response. No new write performed. Response includes `meta.idempotencyReplay: true`.
3. **Same key, different request body (within 24h):** Return `409 Conflict` with `code: "idempotency_conflict"`.
4. **Key not provided:** Process the write normally. No idempotency protection. **EXCEPTION:** the `POST /api/accounting/v1/payments` endpoint REJECTS requests without Idempotency-Key with `400 Bad Request`.

#### Schema for the new `idempotency_keys` table

Columns: `id` (uuid PK), `company_id` (uuid FK), `key` (text — the Idempotency-Key value), `request_hash` (text — SHA-256 of normalized request body), `endpoint` (text — which endpoint was called), `response_body` (jsonb — cached response body), `response_status` (integer — cached HTTP status), `created_at` (timestamptz), `expires_at` (timestamptz — created_at + 24h).

Unique constraint: `(company_id, key, endpoint)` — same key can be used across different endpoints without collision.

Cleanup: a scheduled job deletes rows where `expires_at < now()`. Runs hourly. Implementation flagged for Phase 4b.

#### Key format

Up to 255 characters. Any string the caller wants — UUID v4 recommended. Treated as opaque by the server.

#### What happens at the 24-hour boundary

If the same key arrives 24 hours and 1 minute after the original use, it's treated as a brand-new request. No replay. Intentional — a 24-hour TTL provides plenty of time for legitimate retries without creating an unbounded idempotency-key history.

#### Logging

Every write request logs `idempotencyKey` (if provided) and `idempotencyReplay: true | false`. Together these let us trace whether a write was a fresh action or a replay.

### 3.5 Audit Logging

#### Pattern

Every write attempt (success or failure) generates an entry in the existing `activity_log` table. This is the litigation-defense foundation referenced in the Strategic Plan's 7-year retention policy.

#### Schema additions to `activity_log`

The existing `activity_log` table will be extended with a `status` field (`"success"` or `"failure"`). Phase 4b will determine whether this requires a migration or whether the existing schema already supports it.

#### Entry contents

See Section 2B.1 for the full list of fields captured per entry. Critical fields include: actor identity, tenant identity (company_id + contact_id + platform), endpoint and method, entity affected (with before/after states), idempotency context, status, error info on failures, optional reason, and timestamp.

#### What's NOT in the audit log

- Authentication tokens
- Full request bodies (only the relevant entity-level data, not headers or auth)
- PII beyond what's already in `before`/`after` (e.g., we don't log the client's email address per audit entry — that's already in GHL records)

#### Read endpoints and the audit log

Read endpoints do NOT write to the audit log. Read volume is much higher than write volume, data isn't being changed, and the existing pino-http request logs already capture which agent read what. If audit-log granularity for reads becomes needed (e.g., "prove we never accessed this client's data on date X"), we can add it later — but the v1 scope keeps audit logging tied to state-changing operations.

#### Retention behavior

Audit log entries follow the 7-year data retention policy from the Strategic Plan: production database keeps the most recent N months (configured to balance query speed), older entries archive to long-term storage (Phase 6b work), legal hold mechanism preserves specific entries indefinitely when needed, after 7 years archived entries are securely destroyed (except those under legal hold).

This isn't built in Phase 4 — Phase 4 just creates the entries. Archival and retention enforcement is Phase 6b work, scheduled before Stage 4 of growth.

### 3.6 Logging (Operational)

#### Pattern

Operational logs (separate from audit logs) use the existing `pino` logger via `server/src/middleware/logger.js`. Every request gets a structured log entry through `httpLogger`.

#### Required fields in every accounting route log entry

`actor.type`, `actor.id`, `actor.name` (who called), `companyId`, `contactId`, `platform` (tenant context), `endpoint`, `method`, `latencyMs`, `recordsReturned` (reads only), `entityId` (writes only), `errorCode` (failures only), `idempotencyKey` (writes only), `idempotencyReplay` (writes only).

#### Log levels

- `info` — successful requests
- `warn` — caller errors (4xx)
- `error` — server errors (5xx) and upstream failures (502/504)

#### Sensitive field redaction

The existing pino redaction list strips `req.headers.authorization`. Additionally for the accounting routes, redaction extends to: Idempotency-Key from headers, full request bodies on error paths (already done by existing middleware).

Token values, account balances, and transaction amounts are NOT redacted — they're needed for debugging and they're in `activity_log` anyway.

#### Where logs go

Production: stdout. Railway captures and persists. Searchable via Railway dashboard.

Local dev: same stdout + a `server.log` file via the pino-pretty transport.

No external log aggregation service (Datadog, etc.) in v1. Defer to v2 if needed.

### 3.7 Validation and Input Sanitization

#### Pattern

All inputs are validated at the route handler before any database or upstream API call. Validation uses the existing patterns (no new validation library introduced).

#### Validation rules — common across all endpoints

| Input | Rule |
|---|---|
| `companyId` (query param) | Must be a valid UUID format. Verified via `assertCompanyAccess(req, companyId)`. |
| `contactId` (query param) | Must be a non-empty string. Length ≤ 100. |
| `platform` (query param, optional) | If provided, must be `"xero"` or `"quickbooks"`. |
| Date params (`since`, `from`, `to`, `paymentDate`) | Must be valid ISO 8601 date (YYYY-MM-DD). Must not be in the future (except where explicitly allowed). |
| Numeric body fields (`amount`) | Must be a number. Must be positive. Must have at most 2 decimal places (cent precision). Must be < 10^9 (sanity cap). |
| Enum body fields (`serviceTier`, `reportType`) | Must match one of the documented values. |

#### What we don't validate (intentionally)

- The existence of upstream entities (transaction IDs, invoice IDs) — relies on upstream to return 404
- Account references (`accountRef`) — relies on upstream to reject invalid ones
- Whether the operation makes business sense (paying an already-paid invoice, categorizing a deleted transaction) — pass through and let the upstream decide

These choices reflect "trust the upstream as source of truth" rather than maintaining a duplicate validation layer.

#### Body parsing

JSON bodies parsed by existing Express middleware. Max body size: 1MB (default; sufficient for any single-write request).

---

## Section 4: Test Plan, Deployment Plan, and Future Work

### 4.1 Test Plan

#### Pattern

Every endpoint ships with Vitest tests co-located in `server/src/__tests__/`. Tests run in CI via `pnpm test:run` on every PR. No endpoint merges without passing tests.

#### Test categories per endpoint

**Unit tests:** Test the handler function in isolation with mocked DB and mocked accounting service calls. Cover validation, error responses, response envelope shape, audit log entry generation.

**Integration tests:** Test against the real Express router, with the DB initialized in-memory (existing test pattern). Cover middleware chain (auth + access check), request body parsing, response shape end-to-end.

**Contract tests:** Verify that the response shape matches the documented spec. Field names, types, presence of required fields, structure of meta object.

#### Test scenarios required per endpoint

For each of the 8 endpoints, at minimum:

**Auth tests:** Missing `Authorization` header returns 401 with correct error code; invalid token returns 401; token for actor without company access returns 403.

**Validation tests:** Missing required query parameter returns 400 with parameter name in details; invalid parameter format (e.g., bad UUID) returns 400; invalid body field type returns 400 with field name in errors.

**Multi-tenant isolation tests:** Non-existent `contactId` returns 404 with `code: "no_connection"`; `contactId` for wrong platform returns 404; successful call with correct tenant returns 200 with expected data shape.

**Empty result tests:** Read endpoint returns 0 records as 200 with empty array and `meta.recordCount: 0`; read endpoint returns >5000 records as 200 with `meta.truncated: true`.

**Idempotency tests (write endpoints only):** First call with Idempotency-Key returns 200, write performed, key stored; second call with same key and body returns 200 with `meta.idempotencyReplay: true` and no second write; second call with same key and different body returns 409 with `code: "idempotency_conflict"`; POST /payments without Idempotency-Key returns 400 (REQUIRED for payments).

**Audit log tests (write endpoints only):** Successful write creates audit_log entry with `status: "success"` and complete fields; failed write creates audit_log entry with `status: "failure"`, `error_code`, sanitized `error_message`; audit log entry NOT created when validation fails before any state change attempted.

**Upstream failure tests:** Xero/QBO returns error → 502 with sanitized message; OAuth token refresh fails → 502 with `code: "upstream_auth_failure"`; upstream timeout → 504 with `code: "upstream_timeout"`.

#### What we don't test in v1

- Performance/load testing — defer to v2 if needed
- Penetration testing — defer until before first paying client
- Cross-browser compatibility of the accounting API endpoints — N/A, these are JSON-only. Cross-browser testing for the existing dashboard/portal/diagnostic surfaces and for future HITL/operator UIs is tracked separately as part of those features' QA, not as part of Phase 4.

#### Manual testing before each endpoint enables in production

For each endpoint, before re-enabling the related agent or calling it from production:

1. Call against Enyrgy Inc's real Xero connection with read-only operations
2. Verify response matches spec
3. Verify audit_log entry created (for writes)
4. Verify pino log entry has expected fields
5. Test idempotency replay manually (for writes)

These manual tests are quick (5-10 minutes per endpoint) and catch issues that pure unit tests miss.

### 4.2 Deployment Plan

#### Pattern

Each endpoint is its own commit. Each commit passes CI before merge. Railway auto-deploys on push to master. Endpoints land in production progressively — no big-bang deployment.

#### Endpoint deployment order

Per Section 1.6:

1. `GET /transactions` — first, smallest blast radius, unbreaks 4 agents
2. `GET /bills`, `GET /invoices`, `GET /accounts` — straightforward reads
3. `GET /reports` — last read, response shape spec is TBD per Section 2A.6
4. `POST /transactions/:txnId/category` — first write, lowest risk
5. `POST /payments` — second write, requires Idempotency-Key
6. `POST /invoices` — last write, operates on Ledgerix Pro's own QBO

#### Per-endpoint deployment checklist

For each endpoint:

1. ✓ Implementation complete
2. ✓ Vitest tests pass locally
3. ✓ CI passes
4. ✓ Manual test against real Xero data (Enyrgy)
5. ✓ Pino logs verified
6. ✓ Audit log entries verified (writes only)
7. ✓ Commit pushed; Railway deployment confirmed
8. ✓ Endpoint accessible at `https://api.ledgerixpro.com/api/accounting/v1/...`
9. ✓ Health-check call from local script succeeds

Only after all 9 checks does the endpoint count as deployed. The corresponding agent's AGENTS.md can then be rewritten (Phase 4f) to use the endpoint.

#### Rollback strategy

Each endpoint is a separate git commit. If an endpoint causes issues in production:

1. Revert the specific commit
2. Push the revert
3. Railway auto-deploys
4. Endpoint returns to 404 (matches pre-deployment state)
5. Agents that depend on it return to BROKEN state (no worse than today)

This is safe because we haven't re-enabled any of the BROKEN agents yet. The endpoints don't have downstream dependencies in production until Phase 4f rewires agents.

#### Re-enabling agents (Phase 4f)

After all 8 endpoints are deployed and verified:

1. Rewrite each BROKEN agent's AGENTS.md to use the new endpoints (per the Anti-Hallucination Playbook)
2. Test each rewritten agent in a manually-triggered run
3. Re-enable the agent's cron routine (un-pause)
4. Monitor first few runs closely

Agent re-enabling is sequenced one at a time, in this order:
- Sentinel (least risky, daily read-only)
- Tax Liaison (daily, reads only)
- AP Specialist (the original hallucination culprit — extra scrutiny on first run)
- Audit & Compliance, Payroll, Billing & Invoicing — in any order
- Reconciliation, Senior Bookkeeper, Ledger Specialist, AR Specialist — these involve writes, sequenced after reads-only agents are proven stable

#### Stop conditions

If any of these happen during rollout, halt and investigate:

- A re-enabled agent generates output referencing entities that don't exist in the endpoint response (hallucination indicator)
- A re-enabled agent triggers >5 issues with `status: blocked` in a single run (high error rate indicator)
- An endpoint's error rate exceeds 10% over any 1-hour window
- Any 5xx response from an endpoint (other than 502 from a known Xero/QBO incident)

### 4.3 Future Work (Beyond Phase 4)

#### Phase 5: HITL review tooling

Operator-facing UI for reviewing and approving agent categorization decisions. Highest engineering priority after Phase 4. Reduces founder/operator HITL time per client/day from ~10 minutes to ~3 minutes, enabling the team handoff at Stage 4. Includes client portal authentication hardening as part of the broader browser-surface work in this phase.

#### Phase 5b: Categorization Rule Service

AI analyzes historical BankTransactions to recommend Bank Rules. Surfaces rules in dashboard for human application via Xero UI. Depends on Phase 4 endpoints. Estimated 1-2 weeks of work.

#### Phase 6: Operator handoff UX

Role-based access controls. Audit trail browsing UI. Quality consistency tooling. Enables hiring contractors and offshore staff at Stage 4.

#### Phase 6b: Long-term data retention infrastructure

7-year archival storage. Encryption-at-rest for archived data. Automated promotion of monthly snapshots to long-term storage. Legal hold mechanism. Required before first paying client to honor the data retention policy.

#### Phase 7: Knowledge compounding

Operator decisions feed back into AI suggestions. Cross-operator quality consistency. Industry-specific rule library evolution.

#### Deferred to v2 of this API

- **Rate limiting** — `express-rate-limit` middleware once traffic patterns are known
- **Caching** — chart of accounts especially. Probably Redis-backed once Anthropic API costs become an optimization target
- **OpenAPI/Swagger documentation** — auto-generated from route definitions
- **Per-agent permission scoping** — limits blast radius of compromised agent keys
- **Webhook events** — push notifications for accounting events, if needed by future agents
- **Cross-contact aggregation endpoints** — for cross-client reporting, when justified

#### Decisions that should be revisited as scale changes

- **5000-record safety cap** — may need adjustment if any client accumulates >5000 records in a typical query window
- **24-hour idempotency window** — may need adjustment if retry patterns show longer windows are needed
- **Single audit_log table** — may need partitioning by year once it grows large

These aren't problems today. They're places to watch as the system matures.

#### Pre-Launch Checklist

Before Ledgerix Pro accepts its first paying client, the following items must be complete. None of these block Phase 4 engineering work, but all must be in place before transitioning beta clients to paying status or onboarding new paying clients.

**Legal and compliance (estimated cost: $500-2,000; estimated time: 4-8 hours):**

- [ ] Client agreement / Terms of Service drafted by a small business attorney
- [ ] Privacy Policy posted at ledgerixpro.com
- [ ] Incident response plan documented (data breach notification procedure for Arizona)
- [ ] AZ sales tax obligations confirmed with a CPA (SaaS taxability)
- [ ] Confirm Ledgerix Pro positioning as bookkeeping (not tax preparation — PTIN not required)

**Billing infrastructure (estimated time: 2-4 hours):**

- [ ] Stripe live-mode activation and verification
- [ ] Subscription lifecycle handling tested (creation, renewal, failure)
- [ ] Setup fee collection flow at onboarding
- [ ] Dunning policy decided and implemented (retry attempts, suspension thresholds)
- [ ] Refund processing flow for 30-day satisfaction guarantee
- [ ] Stripe webhooks → GHL contact updates pipeline tested

**Customer support (estimated time: 2-3 hours):**

- [ ] Support email address active and monitored (`support@ledgerixpro.com` or similar)
- [ ] SLA targets confirmed and included in client agreement
- [ ] Escalation paths documented for founder vs. contractor handling
- [ ] GHL conversation tagging conventions established for support tracking

**Email infrastructure (estimated time: 1 hour):**

- [ ] Google Postmaster Tools account set up and verified for ledgerixpro.com
- [ ] MXToolbox baseline check completed; DKIM, SPF, DMARC verified green
- [ ] Email bounce rate baseline established
- [ ] Email deliverability monitoring cadence decided (weekly check during first 90 days)

**Browser surfaces (estimated time: 4-6 hours, mostly engineering):**

- [ ] Client portal authentication hardened (replace slug-based redirect with real auth — natural home is Phase 5)
- [ ] Dashboard secret rotation procedure documented
- [ ] Mobile responsiveness verified for client portal on iOS Safari and Android Chrome

**Operations:**

- [ ] First paying client identified and contracted (signals when this checklist becomes blocking)
- [ ] Onboarding playbook documented for the first paying client (refinements expected after Enyrgy's experience)

**Aggregate effort estimate:** ~15-25 hours of operational work plus $500-2,000 in legal/CPA consultation. Not gating Phase 4 engineering but should be tracked in parallel.

---

**END OF PHASE 4 ACCOUNTING API SPECIFICATION**

