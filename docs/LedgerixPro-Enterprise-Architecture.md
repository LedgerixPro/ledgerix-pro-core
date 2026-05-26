# Ledgerix Pro — Enterprise Architecture

**Railway Cloud Edition — 18-Agent AI Workforce**
**Version 3.4 — May 24, 2026 — CONFIDENTIAL**

| Property | Value |
|---|---|
| Founder & Business Strategist | Scott Hansbury |
| Headquarters | Scottsdale, Arizona |
| Version | 3.4 — May 24, 2026 |
| Horizons Complete | H1, H2, H3, H4 (all in-scope items) |
| Active Agents | 18 (of 25 total configured) |
| Scheduled Routines | 17 cron routines live on Railway |
| Infrastructure | Railway cloud (api.ledgerixpro.com) |
| Beta Clients | None (pre-beta — pipeline ready, no active beta clients pending Pattern B Full Phase 5) |

---

## 1. System Overview

Ledgerix Pro is an AI-powered, autonomous bookkeeping and accounting firm built on the Paperclip AI agent orchestration platform. Deployed on Railway cloud infrastructure, with GoHighLevel (GHL) as the CRM and client data hub. Designed for multi-tenant security, Human-in-the-Loop oversight, and zero data cross-contamination between client workspaces.

### 1.1 Deployment Environment

| Component | Details |
|---|---|
| Runtime Environment | Railway cloud — api.ledgerixpro.com |
| Agent Orchestration | Paperclip AI (`ledgerix-pro-core`) — Railway container |
| Database | External PostgreSQL on Railway — `turntable.proxy.rlwy.net:32057` |
| DB Backups | Automated hourly, 7-day daily, 4-week weekly, 1-month monthly retention |
| CRM Platform | GoHighLevel (GHL) — LIVE |
| Webhook Bridge | `api.ledgerixpro.com/api/webhooks/ghl` — LIVE (no ngrok) |
| Accounting Integrations | Xero — LIVE (multi-tenant per-contact OAuth). QBO — built, pending client. |
| Client Portal | `api.ledgerixpro.com/portal/{contactId}` or `/portal/{slug}` |
| Internal Dashboard | `api.ledgerixpro.com/dashboard` (secret-protected) |
| Diagnostic Calculator | `api.ledgerixpro.com/diagnostic` (public CRO funnel) |
| Company UUID | `f60117de-1131-433c-934f-3fe88bfaa163` |
| GHL Location ID | `GhnRONQQVJiCKsdWoQFc` |
| Board API Key | `pcp_board_railway_admin_key_2026` |

### 1.2 Agent Workforce Summary

| Division | Active Agents | Dormant / Deferred |
|---|---|---|
| Accounting (CFO) | Senior Bookkeeper, Ledger Specialist, Reconciliation Agent, AP Specialist, AR Specialist, Payroll, Reporter, Tax Liaison, Billing & Invoicing | Client Health Monitor (5+ clients) |
| Operations (COO) | Sentinel, Onboarding, Quality Control, Audit & Compliance, Knowledge Base Manager | — |
| Revenue (CRO) | SDR (Laura), Client Success Manager, Referral & Reviews, Reactivation | Sales Outreach (50+ leads) |
| Executive | CEO, CFO, COO, CRO (configured, strategic governance) | — |

### 1.3 Horizon Completion Status

| Horizon | Status | Key Deliverables |
|---|---|---|
| H1 — Foundation | Complete | GHL webhook pipeline, Dispatcher, workspace registry, dual-path auth |
| H2 — Accounting Core | Complete | QBO + Xero OAuth, Sentinel, Ledger Specialist, Reconciliation, Senior Bookkeeper, KB Manager |
| H3 — Operations | Complete | Internal dashboard, weekly digest, budget guardrails, CRO funnel, nurture sequences, SDR (Laura), Client Health Monitor, Reactivation |
| H4 — Full Platform | Complete | Client portal (slug-based), AP Specialist, Tax Liaison, Reporter, Billing & Invoicing, Payroll, Quality Control, Audit & Compliance, Referral & Reviews, AR payment date intelligence, Railway migration, multi-tenant OAuth |
| H4 Deferred | Scale-triggered | Sales Outreach (50+ leads), Scale Pattern (50 clients), KB rules DB table (50 clients) |

### 1.4 Trust Tenet (established 2026-05-24)

No real clients — beta or paying — including Ledgerix Pro's own books are onboarded until the system is correct, trustworthy, and dialed in for security and safety of client funds. This applies uniformly. There is no "ship something today" pressure on safety-critical work; sessions are checkpoints in continuous architectural work, not deadlines for deliverables. Partial-spec compliance on write endpoints touching financial records is rejected as a category — even when it would unblock other work.

Concretely, this means:

- Write endpoints affecting QBO/Xero books cannot ship until the Phase 4c safety architecture is complete
- Audit log entries cannot have placeholder values (e.g., `previousAccountRef: null`) that hide unknown context
- When the test of an endpoint says "X must be captured," X must actually be captured — not nulled out

**Operating Principles** (canonical in repo root `CLAUDE.md`)

1. **Verify before assuming.** Grep for callers before claiming a function is unused. View existing imports before claiming code compiles. Read the authoritative document before quoting values from session memory. Skipping these checks has caused real production-shaped errors.

2. **Session-end documentation discipline.** Every session ends with EA + Brief + relevant trackers + WIP docs all reflecting what was committed. No exceptions. Documents of truth must actually be true at session close.

3. **Locked decisions stay locked.** Once an architectural decision is committed (in ADR, WIP doc Decisions Made, or explicit acknowledgment), it does not get reopened mid-session for refinement. Implementation details discovered during execution are handled during execution, not by reopening the decision.

4. **WIP docs are TRUTH for active work.** If a WIP doc and another doc disagree about an in-flight piece of work, the WIP doc is correct.

**Multi-Session Continuity: `docs/wip/` Convention**

Substantial architectural work that spans multiple sessions has a Work-In-Progress document at `docs/wip/<feature-or-phase>.md`. Required structure: Status, Started, Last-updated, Owner, Related ADRs, Context, Architecture Decisions Made (locked), Architecture Decisions Pending (current focus), Work Done (cumulative, with commit references), Next Steps (ordered, specific), Blockers, NOT Doing (deliberately rejected options), Session Log (append-only).

Discipline rules: update at every session end; read at every session start; locked decisions never reopen; Session Log is append-only; honest status reporting (status doesn't lie about progress).

See `docs/wip/README.md` for the full convention.

---

## 2. Data Architecture — Where Data Lives

| Data Store | Location | What It Stores | Access |
|---|---|---|---|
| Paperclip DB | Railway PostgreSQL | Agent configs, run history, activity logs, budget spend, issues, approvals, accounting_connections | Scott (admin), all agents via server API |
| DB Backups | Railway container filesystem | Hourly snapshots — 7 daily, 4 weekly, 1 monthly retained | Scott (admin) only |
| `accounting_connections` | Railway PostgreSQL — per-contact rows | Xero/QBO OAuth tokens keyed by (company_id, platform, contact_id) | CFO agents via accounting service |
| Railway env vars | Railway environment (never committed) | All API keys: GHL, QBO, Xero, encryption keys, webhook secrets, dashboard secret | Railway admin only |
| GoHighLevel CRM | GHL cloud (SaaS) | Client contacts, pipeline stages, opportunities, forms, communications, tags, custom fields | CRO agents via GHL API, Scott |
| QuickBooks Online | Intuit cloud — per client instance | Chart of Accounts, transactions, invoices, bills, payroll, reconciliations | CFO agents via QBO OAuth API |
| Xero | Xero cloud — per client instance | Chart of Accounts, bank feeds, transactions, reports — per-contact OAuth | CFO agents via Xero OAuth API |
| GitHub Repo | `github.com/LedgerixPro/ledgerix-pro-core` | All source code — NO secrets, NO .env, NO client data | Scott only (private repo) |
| Agent AGENTS.md | Git repo — `agents/{name}/AGENTS.md` | All 18+ agent instructions, SOPs, API call patterns, escalation chains | Scott (author), Paperclip (runtime) |

---

## 3. Multi-Tenant Architecture (H4-14)

As of H4, Ledgerix Pro supports multiple clients with separate accounting connections in a single Paperclip company. Each client's Xero or QBO connection is keyed by their GHL contact ID, enabling true multi-tenant bookkeeping.

### 3.1 `accounting_connections` Schema

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID | Primary key |
| `company_id` | UUID | Always `f60117de…` — the single Paperclip company |
| `platform` | text | `'xero'` or `'quickbooks'` |
| `contact_id` | text (nullable) | GHL contact ID — NULL for legacy global connection |
| `realm_id` | text | Xero tenant ID or QBO company ID |
| `access_token` | text (encrypted) | OAuth access token |
| `refresh_token` | text (encrypted) | OAuth refresh token |
| `access_token_expires_at` | timestamp | Token expiry |

Unique constraint: `(company_id, platform, contact_id)` with `NULLS NOT DISTINCT` — one global NULL row per platform and one per-contact row per platform.

### 3.2 OAuth Connection Flow

| Step | Detail |
|---|---|
| Connect URL | `https://api.ledgerixpro.com/api/oauth/xero/connect?contactId={ghlContactId}` |
| State management | `pendingStates` Map carries `contactId` across OAuth round-trip (10-min TTL) |
| Callback | Stores tokens with `contact_id` in `accounting_connections` |
| Agent access | `getNewTransactions(db, COMPANY_ID, contact.id, sinceDate)` — all agents use this pattern |
| Portal URL | `https://api.ledgerixpro.com/portal/{slug}` → 302 redirect to `/portal/{contactId}` |

---

## 4. Scheduled Routine Architecture

17 cron routines running on Railway, all in America/Phoenix timezone.

| Time (Phoenix) | Cadence | Agent & Routine |
|---|---|---|
| 6:00 AM | Daily | Sentinel — daily transaction sync for all active clients |
| 6:30 AM | Daily | AP Specialist — daily bill check and overdue flag |
| 7:00 AM | Daily | Tax Liaison — daily deadline check |
| 7:30 AM | Mon–Fri | Quality Control — daily spot-check (20% transaction sample) |
| 7:30 AM | Monday | Reporter — weekly pulse digest |
| 7:00 AM | 1st of month | Reporter — monthly deep dive |
| 8:00 AM | Monday | Senior Bookkeeper — weekly digest email to Scott |
| 8:00 AM | 1st of month | Billing & Invoicing — monthly client invoicing |
| 8:30 AM | Monday | AP Specialist — weekly AP summary |
| 9:00 AM | Monday | Tax Liaison — weekly deadline summary |
| 9:00 AM | 1st of month | Reactivation — monthly churn outreach scan |
| 9:00 AM | Tuesday | Referral & Reviews — weekly 30-day and 90-day candidate scan |
| 9:00 AM | Friday | Quality Control — weekly full review and trend analysis |
| 10:15 AM | Monday | Audit & Compliance — weekly compliance scan |
| 11:00 AM | 1st of month | Audit & Compliance — monthly deep scan |
| 11:30 AM | 1st of month | Payroll — monthly payroll compliance review |
| 7:00 AM | Bi-weekly Wed | Payroll — bi-weekly payroll run scan |

**Scale trigger:** At 5 paying clients, enable Client Health Monitor weekly heartbeat — Monday 8am Arizona (cron: `0 15 * * 1` UTC). Register via Paperclip routine API at `/companies/f60117de.../routines`.

---

## 5. Phase-by-Phase Process Architecture

### Phase 1: Lead Generation & Qualification

**Sales Division — CRO Oversight**

#### AGENT: SDR — Sales Development Representative (Laura)

| Aspect | Detail |
|---|---|
| Process | Qualifies inbound leads via ICP scoring (1–10 signal confidence). Sends personalized SMS (referral opener) and email sequences by business type. Creates GHL opportunities. Fires `contact.sdr_ready` webhook on qualification. |
| Inputs | GHL `contact.created` or `contact.sdr_ready` webhook events, ICP qualification criteria, GHL contact custom fields, business type classification |
| Outputs | ICP score written to GHL custom fields, tags added (`icp-qualified`, `sdr-ready`), GHL opportunity created in Sales pipeline, outreach SMS + email sent |

#### AGENT: Client Success Manager

| Aspect | Detail |
|---|---|
| Process | Maintains health scores for all active clients. Delivers plain-English monthly summaries. Monitors churn signals. Runs 30/90/180-day feedback loops. |
| Inputs | Health score inputs (payment timeliness, response rates, GHL engagement), Reporter financial package, escalations from AR Specialist |
| Outputs | Client health scores updated in GHL, monthly touchpoint communications, NPS scores routed to CRO and Referral & Reviews, churn risk alerts |

#### AGENT: Referral & Reviews — Tuesday 9:00 AM weekly

| Aspect | Detail |
|---|---|
| Process | Weekly scan identifies 30-day and 90-day candidates. Sends Google review request at 30 days — checks for open issues first, will not ask during unresolved bookkeeping problems. Sends referral ask at 90 days. Uses tags to prevent duplicate outreach. |
| Inputs | GHL contacts tagged `client-active`, days-as-client calculation, open issue check, `GOOGLE_PLACE_ID` env var for review link |
| Outputs | 30-day check-in email with Google review link, 90-day referral email, GHL tags updated (`review-requested`, `referral-requested`) |

#### AGENT: Reactivation — 1st of month 9:00 AM

| Aspect | Detail |
|---|---|
| Process | Monitors GHL for churned/paused clients. Classifies churn reason. Executes targeted reactivation sequences with defined hard stops. |
| Inputs | GHL pipeline stage changes (Paused/Cancelled/Inactive), churn reason, reactivation offers, Do Not Contact list |
| Outputs | Reactivation sequence messages via GHL, positive response handoffs to Client Success Manager, monthly Churn Intelligence Report to CRO |

### Phase 2: Client Onboarding

**Operations Division — COO Oversight**

#### AGENT: Onboarding — maxTurnsPerRun: 40

| Aspect | Detail |
|---|---|
| Process | Fires on GHL `contact.created` webhook. Checks for `client-active` or `beta-client` tags — if present, escalates instead of re-qualifying. Runs ICP scoring. Sets GHL custom fields (`icp_status`, `signal_confidence_score`, `client_type`, `ledgerix_workspace_id`). Fires `contact.sdr_ready` event. |
| Inputs | GHL `contact.created` webhook with `contactId`, GHL contact custom fields, existing tags (`client-active`, `beta-client` checks) |
| Outputs | ICP score written to GHL, tags added, GHL opportunity created, `contact.sdr_ready` event fired to trigger SDR, escalation issue if existing client detected |

#### AGENT: Knowledge Base Manager

| Aspect | Detail |
|---|---|
| Process | Generates Client Knowledge Package within 24 hours of new client activation. Selects COA template based on client type. Version-controls all documents. |
| Inputs | Client intake data, COA template library (Trades-HVAC, Trades-Plumbing, Agency, Small Business, Manufacturing), GHL contact ID |
| Outputs | Client Knowledge Package (client profile, COA template, industry rules, custom instructions) delivered to Senior Bookkeeper |

### Phase 3: Daily Transaction Processing

**Accounting Division — CFO Oversight**

#### AGENT: Sentinel — Daily 6:00 AM Arizona

| Aspect | Detail |
|---|---|
| Process | Pulls all GHL contacts tagged `client-active`. For each contact, calls `getNewTransactions(db, COMPANY_ID, contact.id, yesterday)` to fetch Xero/QBO transactions via per-contact OAuth connection. Screens every transaction against 90-day baseline. Flags anomalies, duplicates, and high-risk vendors. |
| Inputs | GHL contacts tagged `client-active`, `accounting_connections` table (filtered by `contact_id`), Xero/QBO bank feed transactions from yesterday |
| Outputs | Transaction issues assigned to Ledger Specialist, fraud flags to CFO and COO, runMetrics with `transactionsProcessed`/`autoCategorized`/`flaggedForReview` |

#### AGENT: Ledger Specialist

| Aspect | Detail |
|---|---|
| Process | Assigns COA categories based on vendor history, amount, and industry rules. Standardizes vendor names. Adds job-costing metadata for Trades clients. 80% confidence threshold — below goes to Suspense. |
| Inputs | Cleaned transactions from Sentinel, Client COA, 12-month vendor history, Client Knowledge Package |
| Outputs | Categorized transactions posted to QBO/Xero, Suspense-flagged items with notes, processing summary to Senior Bookkeeper |

#### AGENT: Senior Bookkeeper — Monday 8:00 AM weekly digest

| Aspect | Detail |
|---|---|
| Process | Reviews Ledger Specialist output for GAAP compliance. Detects anomalies >20% variance from 3-month rolling average. 95% confidence threshold. Sends weekly digest email to scott@ledgerixpro.com every Monday 8am. |
| Inputs | Categorized transactions from Ledger Specialist, prior period financial data, client Chart of Accounts |
| Outputs | Verified transactions, GAAP-compliant entries, HITL flags with Reason for Doubt, weekly digest email |

### Phase 4: Accounts Payable & Receivable

**Accounting Division — CFO Oversight**

#### AGENT: AP Specialist — Daily 6:30 AM + Monday 8:30 AM

| Aspect | Detail |
|---|---|
| Process | Records all incoming vendor bills in QBO/Xero. Routes bills above approval threshold for human sign-off. Schedules payments 2 business days before due date. Flags duplicates and new unapproved vendors. |
| Inputs | Vendor bills from QBO/Xero, client approval thresholds, approved vendor list from Knowledge Base Manager |
| Outputs | Bills entered in QBO/Xero, approved payments scheduled, AP Aging Report at month-end, weekly summary email |

#### AGENT: AR Specialist (with Payment Date Intelligence)

| Aspect | Detail |
|---|---|
| Process | Generates invoices, applies payments, executes collections sequence. Payment Date Intelligence: captures confirmed dates from client email replies ('I'll pay by Friday'), uses 12-invoice history to predict payment dates, recalibrates after payment received. Manual override via `PAYMENT_DATE: YYYY-MM-DD` in issue comments. Escalation: Senior Bookkeeper → CFO → Scott. |
| Inputs | Work orders, GHL triggers, incoming payment notifications, client email replies with payment commitments |
| Outputs | Invoices sent via QBO/Xero, payments matched, AR Aging Report, collections sequence via GHL, payment date predictions in QBO/Xero |

#### AGENT: Payroll — Bi-weekly Wednesday 7:00 AM + Monthly 1st 11:30 AM

| Aspect | Detail |
|---|---|
| Process | Monitors payroll expenses posted to QBO/Xero — does not run payroll directly (clients use Gusto/ADP/Paychex). Checks 941 deposit timing, Arizona withholding, W-2 deadlines, FUTA, 1099 vs W-2 misclassification risk. Escalation: Senior Bookkeeper → CFO → Scott. |
| Inputs | QBO/Xero payroll expense transactions, payroll tax deposit tracking, client payroll provider |
| Outputs | Bi-weekly scan results, monthly payroll report email, compliance flags to Senior Bookkeeper, W-2/FUTA deadline alerts in December/January |

### Phase 5: Month-End Reconciliation & Close

**Accounting Division — CFO Oversight**

#### AGENT: Reconciliation Agent

| Aspect | Detail |
|---|---|
| Process | Verifies categorized transactions match official bank statements to the penny. Applies the Penny Rule ($0.00 variance required). Flags stale items, duplicates, and unexplained variances. |
| Inputs | Official bank and credit card statements from QBO/Xero, categorized transactions from Ledger Specialist, prior period closing reconciled balance |
| Outputs | Reconciliation Report ($0.00 variance confirmed or blocked), cleared transaction confirmations, escalations to Sentinel for variances >$500 |

#### AGENT: Quality Control — Daily 7:30 AM Mon–Fri + Friday 9:00 AM weekly

| Aspect | Detail |
|---|---|
| Process | Daily spot-check: 20% transaction sample across four dimensions (categorization accuracy, duplicate detection, anomaly detection, KB rule coverage). Friday weekly full review with trend analysis and recommendations report emailed to scott@ledgerixpro.com. Escalation thresholds: error rate >5% → Senior Bookkeeper (urgent), KB coverage <50% → KB Manager. |
| Inputs | Ledger Specialist completed issues, prior QC runMetrics, KB Manager activity logs |
| Outputs | Daily QC spot-check results, Friday QC weekly report email, QC Alert issues, runMetrics with `errorRate`/`autoCategorizationRate`/`hitlEscalationRate` |

#### AGENT: Reporter — Monday 7:30 AM + 1st of month 7:00 AM

| Aspect | Detail |
|---|---|
| Process | Weekly pulse Monday morning + monthly deep dive on the 1st. Generates P&L, Balance Sheet, Cash Flow Summary, AR Aging Report, and plain-English CFO-level insight per client. |
| Inputs | QC-approved reconciled data from QBO/Xero, Senior Bookkeeper sign-off, client business type |
| Outputs | Monthly financial package to CFO, plain-English summary for client portal, weekly pulse email to scott@ledgerixpro.com |

### Phase 6: Tax & Compliance

**Accounting Division — CFO Oversight**

#### AGENT: Tax Liaison — Daily 7:00 AM + Monday 9:00 AM

| Aspect | Detail |
|---|---|
| Process | Maintains federal and Arizona state tax deadline calendar. Alerts 30 days before every deadline. IRS: 1099-NEC, estimated quarterly payments, 941 deposits. Arizona: TPT, A1-QRT, estimated tax (4.5%). Prepares CPA data packages. |
| Inputs | Reconciled financial data from QBO/Xero, client tax jurisdiction (federal + Arizona), payroll tax alerts from Payroll Agent |
| Outputs | Daily/weekly deadline alerts, 30-day and 7-day warnings, CPA data packages, year-end close checklist |

#### AGENT: Audit & Compliance — Monday 10:15 AM + 1st of month 11:00 AM

| Aspect | Detail |
|---|---|
| Process | Weekly scan + monthly deep scan. Covers IRS (1099, estimated taxes, expense documentation, 50% meal limit), Arizona (TPT, ROC contractor licenses, business licenses), and industry-specific compliance (trades ROC expiration, retail TPT, agency E&O insurance). Escalation: Senior Bookkeeper → CFO → Scott. Never emails Scott for routine flags. |
| Inputs | GHL contacts tagged `client-active` with `client_type`, QBO/Xero vendor payment history, GHL contact notes (ROC license, insurance docs) |
| Outputs | Weekly compliance scan results, monthly compliance report email to scott@ledgerixpro.com, Paperclip issues to Senior Bookkeeper for each compliance finding |

### Phase 7: Internal Revenue Operations

**Internal Operations — CEO/CFO Oversight**

#### AGENT: Billing & Invoicing — 1st of month 8:00 AM

| Aspect | Detail |
|---|---|
| Process | Manages Ledgerix Pro's own revenue. Sends monthly service invoices to all active clients. Service tiers: The Foundation ($199/$299), The Growth Engine ($399/$599), The Scale-Up ($999/$1,299). First 10 clients receive Charter pricing. |
| Inputs | Active client roster from GHL (`client-active` tag), service tier custom field, contracted rates |
| Outputs | Monthly invoices, MRR report to CFO and CRO, revenue leakage risk alerts, Day 30 non-payment escalations to CFO |

---

## 6. Phase 4 — Accounting API & Phase 4c Safety Architecture

Phase 4 builds the HTTP API endpoint layer atop the per-tenant accounting service infrastructure shipped in H2-H4. Pattern B Full (per ADR-001, May 17, 2026) is the primary agent interface — agents call `/api/accounting/v1/*` endpoints rather than invoking service functions directly through scripts.

### 6.1 Endpoint Roster

| Endpoint | Status | Notes |
|---|---|---|
| `GET /transactions` | Production-ready | List with pagination, filtering |
| `GET /transactions/:txnId` | Partial (Decision 4 locked, impl pending) | Needed by write endpoints for `previousAccountRef` capture. Decision 4 (Session 3) locks Option A — full coverage per-type for QBO + Xero. |
| `GET /accounts` | Production-ready | Chart of Accounts retrieval |
| `GET /invoices` | Production-ready | List + filtering |
| `GET /reports/p-and-l` | Production-ready | P&L with Balance Sheet + Trial Balance extensions |
| `POST /transactions/:txnId/category` | DEFERRED (Phase 4c.5) | Atop safety layer. Q3 resolved Session 3 as Decision 4; awaits get-transaction-by-id implementation. |
| `POST /payments` | DEFERRED (Phase 4c.5) | Atop safety layer (thresholds) |
| `POST /invoices` | DEFERRED (Phase 4c.5) | Atop safety layer (pricing + dedupe), blocked on Q1 + Q2 |

5 of 8 endpoints production-ready. Write endpoints intentionally deferred behind Phase 4c safety architecture per the Trust Tenet.

### 6.2 Phase 4b — Write Endpoint Foundation

Three foundational pieces shipped May 23-24 before any write endpoint:

- **Idempotency** via `idempotency_keys` table + `withIdempotency` wrapper. Replays return cached response forever regardless of approval status.
- **Audit logging** via extended `activity_log` table with `status` column (success | failure). Every operation tied to actor identity.
- **Two-phase failure handling** per ADR-002 D2: upstream call inside work callback; audit log success AFTER upstream success; audit log failure BEFORE returning 502.

### 6.3 Phase 4c — Safety Architecture

Every write endpoint sits atop a safety layer that intercepts financial operations and either auto-proceeds (high-confidence cases) or creates a human-in-the-loop approval request (lower-confidence or threshold-breaching cases). This is the operationalization of the Trust Tenet for write operations.

**Endpoint flow:**

1. Validate input
2. Auth check
3. Safety layer checks: pricing match, threshold check, dedupe check, previous-state capture
4. If ANY check returns "approval required" → create approval row, return HTTP 202 Accepted
5. If ALL checks pass → upstream write, audit log success, return 200

#### 6.3.1 Pricing Source of Truth (Phase 4c.1, shipped 2026-05-24)

**Schemas:**

- `service_tier_pricing` — canonical (tier, isCharter) → monthly amount in cents. Effective-dated.
- `client_pricing_overrides` — per-client deviations from canonical. Effective-dated.

**Service:** `getExpectedPriceCents(db, tier, isCharter, contactId?)` returns the expected monthly amount, applying client-specific override if present.

**Migration:** `0065_whole_post.sql`

#### 6.3.2 Threshold Framework (Phase 4c.2, shipped 2026-05-24)

**Schema:** `write_thresholds` — (endpoint, field, comparator, threshold_value, action, reason) tuples. Each can be global (NULL `ghl_contact_id`) or per-client. Effective-dated. Hierarchical: per-client overrides global; per-client can either tighten or loosen vs global default.

**Services:**

- `getApplicableThresholds(db, endpoint, field, contactId)` — returns matching thresholds (global + per-client)
- `getMostSpecificThreshold(db, endpoint, field, contactId)` — returns the threshold that applies
- `isThresholdExceeded(value, threshold)` — comparator evaluation (gt, gte, lt, lte, eq)

**Bootstrap data (seeded into Railway prod 2026-05-25 via `POST /api/admin/thresholds/seed`):**

- Global: `accounting.payments` field `amount` gt 1,000,000 cents = $10K — per Section 7.3 HITL Gates
- Global: `accounting.invoices` field `lineItems.sum` gt 100,000 cents = $1K — conservative anomaly default

✅ **Resolved defect (FIXED 2026-05-26, commit `1727746a`):** The `compareAndSeed` helper previously had a null-identity SQL bug — `eq(col, NULL)` never matches in SQL, so re-running `/api/admin/thresholds/seed` created duplicate active rows instead of skipping (because `ghl_contact_id` is null on global thresholds). Fixed by using `isNull(column)` when the candidate value is null. Pricing seed was always safe (no nullable identity fields). Integration tests against real Postgres added (`server/src/services/admin/compare-and-seed.integration.test.ts`) to prevent regression. Verified end-to-end in Railway prod via re-run on 2026-05-26 at 00:40 UTC: HTTP 200 with `inserted: 0, skipped: 2` (correct idempotency contract). activity_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95`. Re-running the thresholds seed is now safe. See Phase 4c.5 WIP doc Defects Discovered Defect 1 for full bug → fix → verification story.

**Migration:** `0066_familiar_nighthawk.sql`

#### 6.3.3 Customer Dedupe with HITL (Phase 4c.3, shipped 2026-05-24)

Refactored QBO `findOrCreateCustomer` returns `{customerId, action, matchDetails?}` instead of silent string. Five action types:

| Action | Meaning | Auto-proceed |
|---|---|---|
| `found_by_email` | Email match; names similar or empty | Yes |
| `found_by_name_exact` | Name match; no email conflict | Yes |
| `created_new` | No match found; created | Yes |
| `ambiguous_email_match_different_name` | Email matches but names differ significantly | No — approval required |
| `ambiguous_name_only` | Name matches but emails differ (both present) | No — approval required |

**New utility module:** `services/accounting/string-similarity.ts` (`normalizeName`, `levenshteinDistance`, `namesAreSimilar`). Default similarity threshold 3 Levenshtein edits, configurable via `LEDGERIX_NAME_SIMILARITY_THRESHOLD` env var.

When action is HITL-required, caller MUST NOT proceed with the upstream write. Caller creates an approval row with `accounting.invoice.dedupe_ambiguous` type and waits for human resolution.

#### 6.3.4 Write-Approval Dispatcher (Phase 4c.4, shipped 2026-05-24 in stub mode)

When a write endpoint detects a safety condition requiring approval, it creates an approval row instead of executing the write. When the approval is later approved by a human, the dispatcher executes the deferred write using the payload data.

**Module:** `services/accounting/write-approvals.ts`

**Four approval types (dot-namespaced per ADR-003 Q1):**

- `accounting.payment.threshold_exceeded`
- `accounting.invoice.dedupe_ambiguous`
- `accounting.invoice.pricing_mismatch`
- `accounting.transaction.category_with_unknown_previous`

Each type has a TypeScript payload interface capturing all data needed to execute the deferred write.

**Dispatcher integration:** `approvalService.approve()` extended to call `executeApprovedAccountingWrite(db, approval)` when approval type matches `accounting.*`. Dispatcher failures do NOT roll back the approval — the approval IS approved; the downstream write either succeeded, will be retried, or failed in ways needing human follow-up.

**Stub mode:** Phase 4c.4 ships the routing infrastructure; each case logs the approved-write event but does NOT execute the upstream QBO/Xero write. Phase 4c.5 will replace each stub case with the actual upstream call.

#### 6.3.5 Write Endpoint Re-Implementation (Phase 4c.5, IN PROGRESS)

Re-ship `POST /transactions/:txnId/category`, `POST /payments`, `POST /invoices` atop the complete safety layer. Wire Phase 4c.4 dispatcher stubs to real upstream writes.

**Part 1 shipped (commit `e618231b`, 2026-05-24):**

- Migration `0067_last_gateway.sql` — `activity_log.company_id` nullable for system-scoped admin operations
- `LogActivityInput` type accepts `companyId: string | null`
- Live-events and plugin-events suppressed when companyId is null
- Generic helper `services/admin/compare-and-seed.ts` for version-aware idempotent seeding
- WIP doc shipped at `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md`

**Part 2 shipped (commit `ff3875e8`, 2026-05-25):**

- Admin endpoints mounted in production at `POST /api/admin/pricing/seed` and `POST /api/admin/thresholds/seed`
- `compareAndSeed` generics refactored (Option A): `TRow` defaulted to `TSchema["$inferSelect"]` so identity/value/effective-to field names get compile-time protection against the actual schema (not just the candidate row shape)
- Helper unit tests (7 tests) + endpoint integration tests (9 tests)
- 161 targeted tests passing (145 baseline + 16 new); full monorepo typecheck clean

**End-of-day bootstrap (2026-05-25):**

- `POST /api/admin/pricing/seed` → HTTP 200, `inserted: 6, skipped: 0`. activity_log `e6b9d177-d313-4b6f-902b-c0ac9a5fbf6f`. Six canonical pricing rows live in `service_tier_pricing` matching Section 8 values.
- `POST /api/admin/thresholds/seed` → HTTP 200, `inserted: 2, skipped: 0`. activity_log `99273b65-c078-45e2-8263-ebfaab0e7296`. Two canonical threshold rows live in `write_thresholds` matching Section 6.3.2 bootstrap values.
- Both audit-logged under admin@ledgerixpro.com's user identity with `company_id = NULL` per Decision B.

**Defect discovered during idempotency re-run (2026-05-25):**

Re-running the seeds was intended to verify Decision 3's idempotency contract. Pricing held the contract (re-run returned `skipped: 6`). Thresholds did NOT (re-run returned `inserted: 2` instead of `skipped: 2`, creating duplicate active rows). Root cause: `compareAndSeed` used `eq(col, value)` for all identity-match conditions, including when value was null; `eq(col, NULL)` never matches in SQL. Pricing was safe (no nullable identity fields); thresholds was affected (`ghl_contact_id` is null on global thresholds). Unit tests didn't catch this because the mock `db.where()` is a no-op pass-through that doesn't model SQL semantics. Duplicate rows cleaned up via hard DELETE; activity_log entries preserved per audit-retention principles.

**Defect resolved (commit `1727746a`, 2026-05-26):**

Helper changed to use `isNull(column)` when the candidate identity value is null instead of `eq(column, null)`. Non-null values still go through `eq` unchanged. New integration test file `server/src/services/admin/compare-and-seed.integration.test.ts` with 3 tests against real embedded Postgres exercises the null-identity case end-to-end. Tests were written TDD-style: 2 tests verified FAILING against the unfixed helper, all 3 PASS after the fix. Prod verified by re-running `POST /api/admin/thresholds/seed` post-deploy: HTTP 200, `inserted: 0, skipped: 2` (Decision 3 contract restored). activity_log `e6d8b7f5-a851-4af9-a5f5-164acc940f95` permanently captures the post-fix re-run. psql confirmed `write_thresholds` still has exactly 2 active rows (no duplicates). Generalizable lesson codified: SQL-predicate helpers in this codebase should use integration tests against real Postgres (via `startEmbeddedPostgresTestDatabase`), not just mocked unit tests. See WIP doc Defects Discovered Defect 1 Resolution for the full audit trail (3-UUID timeline showing bug → fix → verification).

**Architecture Decisions locked in Phase 4c.5** (in WIP doc):

| Decision | Locked | Summary |
|---|---|---|
| 1 | 2026-05-24 | Admin HTTP endpoints (not one-time scripts) for safety-layer data management. Required for 7-year audit retention. |
| 2 (revised) | 2026-05-24 | Admin endpoints use existing `assertInstanceAdmin` from `authz.ts` (natively supports session, board_key, local_implicit — all identity-tracked). |
| 3 | 2026-05-24 | Version-aware idempotency (Option D-modified). Identical → skip; different → supersede with effective-dating; missing → insert. |
| B | 2026-05-24 | `activity_log.company_id` nullable for system-scoped admin operations. |
| Option 1 | 2026-05-24 | Live-events and plugin-events suppressed when companyId is null. |

**Architecture questions pending** (each blocks specific endpoints):

- **Q1: Charter status storage** — blocks Invoice endpoint. `getExpectedPriceCents` requires `isCharter` parameter; no defined storage exists yet.
- **Q2: Setup fee handling** — blocks Invoice endpoint. Setup fees ($249/$349/$1,200 per Section 7) not modeled by current pricing schema.
- ~~**Q3: get-transaction-by-id infrastructure scope**~~ — RESOLVED Session 3 (2026-05-26) as Decision 4 (Option A — full coverage). Per-type fetch handlers for 7 QBO types + 4 Xero types behind a unified `getTransactionById` interface returning `previousAccountRef` to callers. Implementation pending (5-7 hours estimated). See `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md` Decision 4 for the locked interface contract and per-type checklist.

**Explicitly rejected (NOT Doing):**

- One-time scripts for seeding (7-year audit retention requires durable activity_log)
- Every-category-update-needs-approval (doesn't scale to 50+ clients)
- `previousAccountRef: null` placeholder (Trust Tenet)

### 6.4 Architectural Decision Records

Phase 4 architectural decisions are captured in ADR documents under `docs/adr/`:

- **ADR-001** — Pattern B Full API endpoints as primary agent interface
- **ADR-002** — Phase 4b write endpoint design (idempotency, audit, two-phase failure)
- **ADR-003** — Phase 4c safety architecture (10 decisions + 3 amendments)
- **ADR-004** — Pending; will capture Phase 4c.5 locked decisions when Phase 4c.5 ships

---

## 7. Data Security & Guardrails

### 7.1 The Four Core Security Guardrails

| Guardrail | How It Works | Why It Matters |
|---|---|---|
| 1. Data Isolation | Each client keyed by GHL contact ID in `accounting_connections`. All agent queries filter by `contact_id`. No agent can access another client's data. | Company A's books never touch Company B's data. A breach is a Level 1 emergency. |
| 2. Access Limits | QBO and Xero OAuth scopes: read-only for reports, read/write for transactions. Money movement is never requested in OAuth scopes. | Even a compromised agent cannot move money. Worst case: a miscategorized transaction. |
| 3. Token Budgeting | Agent budget caps enforced in Paperclip. Current beta caps ~$215/mo for 2 clients. Scale targets: ~$1,225 at 25, ~$3,110 at 75, ~$5,480 at 150, ~$9,700 at 300. | Prevents AI cost runaway. Revisit at each 25-client milestone. |
| 4. Human Gate | No transaction marked Verified below 95% Senior Bookkeeper confidence. All HITL flags held for human review in dashboard queue. | AI does the work, humans own the outcome. Core trust mechanism for clients. |

### 7.2 Escalation Chain

Standard escalation chain across all Ledgerix Pro agents:

**Senior Bookkeeper → CFO → Scott**

No agent contacts Scott directly for routine operational issues. Scott is notified only when the escalation chain is exhausted or for Level 3 events (confirmed fraud, data breach, client cancellation).

### 7.3 Human-in-the-Loop Gates

| Gate | Trigger / Condition |
|---|---|
| 95% confidence threshold | Senior Bookkeeper flags any transaction below 95% confidence with Reason for Doubt |
| $0.00 reconciliation close | Senior Bookkeeper and CFO must sign off before period is declared closed |
| New Chart of Accounts category | No new COA category created without human administrator approval |
| Payroll runs >$10,000 | CFO must sign off before processing |
| **Phase 4c safety layer** | **Every write endpoint operation passes through pricing / threshold / dedupe / previous-state checks. Any "approval required" outcome creates an approval row (per ADR-003 Q1 type taxonomy) and returns HTTP 202 — actual upstream write deferred until human approval.** |
| Client cancellation | CEO and human admin must lead — no autonomous retention |
| Level 3 financial risk | Confirmed fraud or material misstatement — immediate CEO notification, workspace paused |
| Data isolation breach | Any cross-client data event — Level 1 emergency, CEO + human admin notified immediately |
| Budget cap exceptions | CEO must authorize any exception to per-client budget caps |
| Reactivation offers | CRO must authorize all win-back offers with defined expiration dates |

### 7.4 API Key & Secret Management

| Secret | Storage | Protection Method |
|---|---|---|
| `ANTHROPIC_API_KEY` | Railway env var (no quotes) | Never committed. Critical: no quotes in Railway env vars — quoted values cause auth failures. |
| `GHL_API_KEY` | Railway env var | Never committed. Rotated every 90 days. |
| `GHL_WEBHOOK_SECRET` | Railway env var | Shared secret — `X-Ledgerix-Secret` header on every inbound GHL webhook |
| `ENCRYPTION_KEY` | Railway env var | 32-byte hex key for encrypting OAuth refresh tokens at rest |
| `DASHBOARD_SECRET` | Railway env var | SHA-256 hash — protects `/dashboard` route |
| `QBO_CLIENT_ID/SECRET` | Railway env var | OAuth 2.0 for QuickBooks Online |
| `XERO_CLIENT_ID/SECRET` | Railway env var | OAuth 2.0 for Xero — LIVE |
| `DATABASE_URL` | Railway env var (internal) | Railway internal Postgres connection string |
| `GOOGLE_PLACE_ID` | Railway env var (pending) | Added when Google Business profile is claimed — used by Referral & Reviews agent |

### 7.5 Safety Layer (Phase 4c)

Position in stack: between HTTP route handler and QBO/Xero service call. Every write endpoint must traverse this layer. See Section 6.3 for full architecture.

Mechanism: each write endpoint, before executing the upstream write, queries the safety layer for pricing check, threshold check, dedupe check, and previous-state capture. If ANY check returns "approval required," the endpoint creates an approval row with the full request payload and returns HTTP 202 Accepted. The actual upstream write is deferred until a human approves. The Phase 4c.4 dispatcher executes the deferred write when approval is granted.

Why this matters: AI agents can make write requests at machine speed; the safety layer ensures human review on anything that materially affects client books — without making EVERY write require approval (which would not scale to 50+ clients).

---

## 8. Service Tiers & Pricing

Updated May 17, 2026 (v3.2). Growth Engine Standard moved from $499 to $599 and Scale-Up repriced to $999/$1,299 to match market positioning for specialist trades and agency bookkeeping. First 10 clients receive Charter pricing; the Charter benefit follows the client across tier upgrades and downgrades for as long as service is continuous (see Section 8.1 Charter Pricing Window). All pricing is monthly recurring.

| Tier | Target Client | Charter | Standard | Key Features |
|---|---|---|---|---|
| The Foundation | Freelancers & Micro-business | $199/mo | $299/mo | Full bookkeeping, monthly P&L, tax deadline alerts |
| The Growth Engine | Local Trades & Service businesses | $399/mo | $599/mo | Foundation + job costing, ROC license tracking, TPT compliance |
| The Scale-Up | Agencies & Law Firms | $999/mo | $1,299/mo | Growth Engine + trust account compliance, E&O tracking, multi-entity |

### Setup & Migration Fee

All clients (including Charter) pay a one-time setup fee at onboarding. The fee covers chart of accounts review, vendor categorization rules, platform connection, workflow training, and (for prospects not currently on QBO or Xero) data migration. No waivers.

| Tier | Setup Fee |
|---|---|
| The Foundation | $249 |
| The Growth Engine | $349 |
| The Scale-Up | $1,200 |

The setup fee applies once at onboarding. It is non-refundable except per the 30-day satisfaction guarantee (see Strategic Plan).

### 8.1 Tier Qualifiers

Industry framing drives the marketing pitch; the qualifiers below drive the price quoted at the discovery call. Most qualifiers must match to land a client in a given tier. If a client splits across tiers (for example, Growth Engine on transaction volume but Scale-Up on entity count), price to the higher tier and call out the upgrade rationale in the proposal.

| Qualifier | Foundation | Growth Engine | Scale-Up |
|---|---|---|---|
| Monthly transaction volume | Up to 75 | 75–300 | 300+ |
| Bank/credit accounts | 1–2 | 2–5 | 5+ |
| Employees on payroll | 0–2 | 3–15 | 10–25 |
| Accounting integrations | 1 platform | 2–3 platforms (FSM, etc.) | 3+ platforms |
| Annual revenue | Under $500K | $500K–$3M | $2M+ |
| Job costing required | No | Yes | Yes |
| Trust/multi-entity | No | No | Yes |
| Industry flags | None | ROC, TPT, seasonal | IOLTA, E&O, accrual |

### Charter Pricing Window

Charter pricing applies to the **first 10 paying clients only**. After client #10, the Charter column closes and new clients onboard at Standard pricing.

**Charter benefit follows the client across tiers.** As long as service is continuous, Charter clients keep Charter pricing for the duration of their relationship with Ledgerix Pro — even as their business grows from one tier to the next. A Foundation Charter client whose qualifiers move them to Growth Engine pays Growth Engine Charter ($399/mo), not Standard ($599/mo). Same applies for Scale-Up: Charter clients who grow into Scale-Up pay Scale-Up Charter ($999/mo), not Standard ($1,299/mo). The benefit also applies on tier downgrades: a Scale-Up Charter client whose qualifiers shrink to Growth Engine pays Growth Engine Charter, not Standard.

**Continuity rule.** If a Charter client cancels service and later returns, they re-enter at Standard pricing for whichever tier they qualify for. The Charter benefit is granted to the first 10 paying clients as a thank-you for choosing Ledgerix Pro early; it is not transferable, sellable, or recoverable after cancellation.

### 8.2 Scale Milestones & Triggers

| Milestone | Action Required |
|---|---|
| 5 paying clients | Enable Client Health Monitor weekly heartbeat: cron `0 15 * * 1` (Monday 8am Arizona / 15:00 UTC) |
| 10 clients | Charter pricing window closes — new clients at Standard pricing |
| Each 25-client milestone | Revisit agent budget caps. Targets: ~$1,225 at 25, ~$3,110 at 75, ~$5,480 at 150, ~$9,700 at 300 |
| ~50 leads | Enable Sales Outreach agent (H4-9) |
| ~50 clients | Implement Scale Pattern for accounting webhooks (QBO webhook renewal cron, queue-based burst processing, dead letter handling) |
| ~50 clients | Migrate KB rules to database table for faster agent lookup (H4-12/13) |

---

## 9. Client Portal & Dashboard

### 9.1 Client Portal

| Property | Detail |
|---|---|
| URL format (contact ID) | `https://api.ledgerixpro.com/portal/{ghlContactId}` |
| URL format (slug) | `https://api.ledgerixpro.com/portal/{company-slug}` → 302 redirect to contact ID URL |
| Slug generation | Company name slugified: spaces → hyphens, lowercase, special chars stripped. 'Acme Industries' → 'acme-industries' |
| Authentication | None for beta — `contactId` is effectively the token. Add proper auth before paying clients request it. |
| Current beta clients | None — pending Pattern B Full Phase 5 |

### 9.2 Internal Dashboard

| Property | Detail |
|---|---|
| URL | `https://api.ledgerixpro.com/dashboard` |
| Authentication | Dashboard secret (SHA-256 hash) entered on load |
| Content | Agent health status, HITL queue, active clients list, last run times, issue counts |
| Summary API | `https://api.ledgerixpro.com/dashboard/summary` (JSON) |
| Agent health statuses | idle / running / degraded (timeout count >5 in recent runs) |

---

## 10. Live Integration Status (May 2026)

| Integration Component | Status | Detail |
|---|---|---|
| Railway deployment | LIVE | `api.ledgerixpro.com` — auto-deploys on git push to master |
| GHL webhook pipeline | LIVE | `contact.created`, `contact.updated`, `contact.sdr_ready` all routing correctly |
| Xero OAuth (multi-tenant) | LIVE | Per-contact connections via `/oauth/xero/connect?contactId=...` |
| QBO OAuth (multi-tenant) | LIVE | Built and deployed — pending first QBO client |
| Xero webhook | LIVE | Registered at developer.xero.com — Invoices, Contacts, Credit Notes, Billing Subscriptions. Status: OK. |
| All 17 cron routines | LIVE | Firing on schedule — Sentinel, AP Specialist, Tax Liaison confirmed running daily |
| Client portal (slug-based) | LIVE | Slug redirect working: `/portal/{company-slug}` → 302 → `/portal/{contactId}` |
| Scanner path hardening | LIVE | `/.env`, `/.git/*`, `/.aws/*`, URL-encoded variants all returning 404 |
| DB hourly backups | LIVE | Confirmed running — ~296KB snapshots every hour, 7-day daily retention |
| A2P SMS messaging | PENDING | GHL Trust Center approval pending — Laura's SMS outreach queued |
| Google Business Profile | PENDING | `GOOGLE_PLACE_ID` to be added to Railway after profile is claimed |
| Client portal auth | DEFERRED | Add proper token auth when first paying client requests portal access |

---

## 11. Railway Deployment Reference

### 11.1 Key Infrastructure Facts

- Railway auto-deploys on every push to master branch of `github.com/LedgerixPro/ledgerix-pro-core`
- Dockerfile: `node:22-bookworm-slim`, non-root paperclip user (UID 1001), Claude CLI 2.1.138
- **CRITICAL:** Railway env vars must NOT have quotes. `KEY=value`, never `KEY="value"`. Quoted values caused `ANTHROPIC_API_KEY` auth failures.
- Migrations apply automatically on container boot via Paperclip's migration runner
- If Railway does not auto-redeploy after push: use an empty commit to trigger (`git commit --allow-empty`)

### 11.2 GHL Custom Fields

| Field Name | Internal ID | Purpose |
|---|---|---|
| `service_tier` | `Dh5rwdlahz6a37BAQDIs` | Client service tier (The Foundation / The Growth Engine / The Scale-Up) |
| `client_type` | `Cf539co3LHJrm6wLAJQJ` | Business type (manufacturing, trades, agency, law_firm, retail, etc.) |
| `ledgerix_workspace_id` | `vmAT4OjG10QboXA2Jqjs` | Paperclip company ID (vestigial post-H4-14 — retained for backward compat) |
| `nurture_month` | `sMQegZrU2giDsyaNKnjt` | Nurture sequence month tracking |

### 11.3 GHL Pipeline IDs

| Pipeline | ID |
|---|---|
| Sales Pipeline | `dtgrQV0u9DB5EmxJGY9K` |
| Clients Pipeline | `EOq8U8BCqRMX9kM5g2qS` |
| Churn Pipeline | `A4SSmXmDnwPKGfxKcvut` |

### 11.4 Beta Client Reference

**Beta clients:** None active. Enyrgy Inc will be onboarded through the production pipeline (`api.ledgerixpro.com/free-audit` → Tier-Fit Audit → standard onboarding flow) once Pattern B Full Phase 5 ships.

### 11.5 Key File Locations

| File / Directory | Purpose |
|---|---|
| `agents/{name}/AGENTS.md` | Agent instructions — 18 active agents, each with full SOP |
| `server/src/routes/oauth/xero.ts` | Xero OAuth routes — per-contact connect and callback |
| `server/src/routes/oauth/quickbooks.ts` | QBO OAuth routes — per-contact connect and callback |
| `server/src/routes/webhooks/ghl.ts` | GHL webhook receiver with dual-path auth |
| `server/src/routes/ledgerix-dashboard.ts` | Dashboard, portal, and slug redirect routes |
| `server/src/services/accounting/index.ts` | `getNewTransactions` — primary accounting data access function |
| `packages/db/src/schema/accounting_connections.ts` | Multi-tenant accounting connections schema |
| `RESET.md` | Complete recovery runbook — 31 sections including backup recovery (Section 31) |
| `.env.example` | Safe placeholder template for all Railway environment variables |

### 11.6 Database Migrations

Migration head: `0067_last_gateway.sql`

Recent migrations relevant to Phase 4:

| Migration | Purpose | Phase |
|---|---|---|
| `0064_aged_iron_man` | `activity_log.status` column + `idempotency_keys` table | Phase 4b foundation |
| `0065_whole_post` | `service_tier_pricing` + `client_pricing_overrides` | Phase 4c.1 |
| `0066_familiar_nighthawk` | `write_thresholds` | Phase 4c.2 |
| `0067_last_gateway` | `activity_log.company_id` nullable | Phase 4c.5 Decision B |

Migration workflow: edit schema TypeScript file → `pnpm generate` → drizzle-kit auto-creates SQL + snapshot. Apply automatically on container boot via Paperclip migration runner.

### 11.7 Test Coverage Baseline

Current targeted test count: **145 tests passing**

| Domain | Tests | Phase |
|---|---|---|
| Accounting routes | 62 | Phase 4a |
| Idempotency | 14 | Phase 4b |
| Pricing | 10 | Phase 4c.1 |
| Thresholds | 14 | Phase 4c.2 |
| String similarity | 25 | Phase 4c.3 |
| `findOrCreateCustomer` | 9 | Phase 4c.3 |
| Write-approvals dispatcher | 11 | Phase 4c.4 |

Targeted vitest runs (`pnpm exec vitest run <file>`) are reliable. Full server suite (`pnpm exec vitest run` — 1240 tests) has known flakiness in `src/__tests__/workspace-runtime.test.ts` due to parallel-run resource contention. Verified 2026-05-24: same tests pass cleanly when run in isolation. Pre-existing infrastructure issue unrelated to current work.

---

**LEDGERIX PRO — CONFIDENTIAL**

Scott Hansbury | Founder & Business Strategist | Scottsdale, Arizona | Version 3.4 | May 24, 2026
