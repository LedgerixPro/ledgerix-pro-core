# Ledgerix Pro — Master Task List

Priority-ordered build list. Updated: 2026-05-27.

**Taxonomy:** This file uses two top-level concepts. **HORIZONs** are time-sequenced readiness buckets (1 = pre-launch, 2 = post-first-client, 3/3.5 = bookkeeping + hardening, 4 = client portal + revenue). **PHASEs** are cross-cutting architectural workstreams that may span multiple horizons (e.g., PHASE 4 = Accounting API, which powers HORIZON 3 bookkeeping agents AND HORIZON 4 H4-5 Ledgerix Pro billing). When a phase ships fully, its sub-items collapse into the Completed ✅ archive at the bottom; the phase header stays as a historical reference. Active multi-session work also lives in `docs/wip/<feature>.md` files; TODO.md is the roadmap-level rollup.

---

## HORIZON 1: Pre-Launch
*Must complete before first paying client.*

- [x] **1. Build the GHL diagnostic survey** — Completed: 2026-05-01
  Diagnostic calculator live at /diagnostic. Calculates Stun Value for Trades/Agency/Small Business.
  Writes diagnostic_amount + service_tier to GHL contact on submission.

- [x] **2. Wire the SDR agent** — Completed: 2026-05-02
  Laura (SDR agent) operational. Sends from laura@ledgerixpro.com. GHL workflow + dispatcher route + AGENTS.md + claude_local config all wired. Reply-detection workflow live (contact.replied → Laura classifies sentiment, sends personalized reply with diagnostic + booking links). See Completed section for related entries (Laura persona, Reply detection, Diagnostic URL fixes).

- [x] **3. QBO/Xero OAuth integration** — Completed: 2026-05-01
  QBO OAuth live, tokens encrypted in accounting_connections, sandbox read verified (89 accounts, company info).
  Xero OAuth also live — tenantId 33172510, sandbox read verified (103 accounts). Both connections in accounting_connections, isolated by platform column.

- [x] **4. Production domain setup** — Completed: 2026-05-01
  Cloudflare Tunnel, ID cdcb2ef5-d434-46dc-894b-00dcc125b475, permanent URL api.ledgerixpro.com
  Move off ngrok free tier. URLs rotate on every restart — not viable for a real client.
  Options: ngrok paid ($8/mo stable subdomain), Railway, Fly.io.
  Status: pending (noted in original infrastructure plan).

- [x] **5. Rotate GHL webhook secret before go-live** — Completed: 2026-05-01
  New secret starts with 1b84fdf9. Old secret d60358 is dead. Both GHL workflows updated.

---

## HORIZON 2: Post-First-Client Workflows
*Complete after first client, before scale.*

- [x] **7. Wire the Opportunity Won workflow** — Completed: 2026-05-02
  CSM agent wired, GHL workflow published, client pipeline created (EOq8U8BCqRMX9kM5g2qS), welcome email from scott@ledgerixpro.com via Outlook sync. Triggers on Opportunity Stage → Won; creates client workspace and assigns CSM agent.

- [x] **8. Wire the Opportunity Lost workflow** — Completed: 2026-05-03
  CSM agent handles lost prospects: tags updated, gracious lost email from scott@ledgerixpro.com, 6-month nurture sequence tagged, SMS notification. GHL workflow published. Also covers Client Churn workflow (separate trigger but same handling pattern).

- [x] **10. Build the CS / Client Success agent** — Completed: 2026-05-03
  CSM agent operational; handles Opportunity Won/Lost, Client Churn workflows. Client Health Monitor agent (separate) handles event-driven health alerts: invoice.overdue, accounting.stale, nps.low → routes to CRO, moves contacts to At Risk stage, SMS notification. CSM + Client Health Monitor together cover the original CS scope. Weekly heartbeat deferred until 5 active clients.

- [x] **11. Build the Billing / AR agent** — Completed: 2026-05-03
  AR Specialist agent operational: 3-touch invoice collection sequence (7/14/30 days), bill.due internal visibility, escalates to CRO at 30 days, SMS + at-risk tagging. Plus Billing & Invoicing agent (H4-5): monthly 1st-of-month QBO invoice creation with charter pricing tag. AR Specialist covers overdue follow-up; Billing & Invoicing handles invoice creation.

- [x] **12. Build the Invoice Paid GHL webhook workflow** — Completed: 2026-05-03
  QBO (CloudEvents format, ahead of May 15 deadline) and Xero (ITR handshake verified) both live. Auto-dispatches invoice.paid → AR Specialist. Growth pattern implemented (auto-register on OAuth).

---

## HORIZON 3: Bookkeeping Engine

- [x] **29. Sentinel agent** — daily transaction puller, cron 0 6 * * * America/Phoenix, routine registered. Completed: 2026-05-08
- [x] **30. Ledger Specialist agent** — categorizes transactions, reads KB rules, HITL ≥$1,000, enqueues Reconciliation. Completed: 2026-05-08
- [x] **31. Reconciliation agent** — matches bank transactions to invoices, HITL ≥$999.99, triggered by Ledger Specialist. Completed: 2026-05-08
- [x] **32. Senior Bookkeeper agent** — claude-opus-4-7, three-tier HITL ($1k/$10k), writes back to QBO/Xero, enqueues KB Manager. Completed: 2026-05-08
- [x] **33. Knowledge Base Manager agent** — builds client-specific categorization rules, additive KB-as-issue design. Completed: 2026-05-08
- [x] **34. QBO/Xero write-back API methods** — updateTransactionCategory, reconcilePayment, applyPaymentToInvoice for both platforms. Completed: 2026-05-08

- [x] **35. Wire KB consumption into Ledger Specialist** — Completed: 2026-05-08 (inline during bookkeeping engine build with items 29–34).
- [ ] **36. ~~knowledge_base_rules DB table~~** — SUPERSEDED by H4-13 (KB rules DB table). Original scope preserved for traceability: replace KB-as-issue design with a dedicated table at scale (50+ clients). Active tracking now under H4-13.
- [x] **37. Agent observability dashboard** — internal dashboard live at api.ledgerixpro.com/dashboard. Secret-gated, 30s auto-refresh, agent health grid, HITL queue, active clients. Backend + frontend complete. Completed: 2026-05-08
- [x] **38. Weekly client email digest** — Senior Bookkeeper sends branded HTML Monday 8am digest to all active clients. Metrics from runMetrics (transactions, categorized, reconciled, reviewed). Skips clients with no activity. Routine registered. Completed: 2026-05-08
- [x] **39. Structured execution state** — run_metrics jsonb column added to issues table (migration 0061), runMetrics field in createIssueSchema/updateIssueSchema, all four bookkeeping agents updated to PATCH runMetrics at end of each run. Dashboard reads real counts tomorrow after 6am Sentinel run. Completed: 2026-05-08

## HORIZON 3.5: Scale & Hardening
*Post-launch, post-first-10-clients.*

- [ ] **16. Move to production infrastructure**
  Railway, Fly.io, or similar. Stable URL, TLS, uptime monitoring, auto-restart.

- [ ] **17. ~~Upgrade GHL to OAuth Marketplace App~~** — SUPERSEDED by H4-14 (multi-tenant architecture). Original scope preserved for traceability: required if client data lives in their own GHL sub-accounts. Full OAuth flow, per-location token storage, automatic refresh. Pattern X → Pattern Y upgrade path. Active tracking now under H4-14.

- [ ] **18. Reusable idempotency middleware**
  Currently dedup is per-route (contact.created). Every new event type needs same treatment.
  Build once as middleware rather than implementing per-route.

- [ ] **19. GHL webhook IP allowlisting**
  GHL publishes source IP ranges. Allowlist them as second security layer beyond shared secret.

- [ ] **20. Diagnostic survey backfill agent**
  Once survey is live, existing Qualified contacts with no `diagnostic_amount` need a follow-up touchpoint.
  One-time backfill campaign.

- [ ] **21. Multi-tenant Paperclip workspace architecture**
  When real clients need data siloing: each client gets own Paperclip company workspace, own agents, own GHL location mapping, own QBO/Xero connection.
  Currently: one company `f60117de-1131-433c-934f-3fe88bfaa163` serves all operations.

- [ ] **22. Per-event idempotency key validation**
  Current dedup key (`ghl-webhook:eventType:contactId`) correct for contact events.
  Validate and implement for each new event type added (opportunity, invoice, form, appointment).

- [ ] **23. AR automation — payment date rescheduling**
  Automate payment date rescheduling when client replies to invoice reminder (currently handled manually via GHL Conversations).

- [x] 6-month lost prospect nurture sequence — Reactivation agent, monthly cron 0 9 1 * * America/Phoenix, alternates Laura (months 1/3/5) and Scott (months 2/4/6), personalized by client_type (Trades/Agency/Small Business), tracks progress via contact.nurture_month GHL custom field. Completed: 2026-05-08

- [x] **24. Full CRO funnel workflows** — CRO org fully wired: SDR/Laura, CSM, Client Health Monitor all active and connected. Client Health Monitor org line fixed (now reports to CRO). Sales Outreach, Referral & Reviews, Reactivation deferred to HORIZON 4 (outbound/referral programs). Completed: 2026-05-08

- [x] **25. Audit all agent budget guardrails** — all 14 active agents (10 claude_local + 4 C-Suite) now have monthly spend caps. Beta total cap: $270/mo. Scale table documented. Revisit at each 25-client milestone. Completed: 2026-05-08

- [x] **26. ~~Build agent audit trail / observability~~** — SUPERSEDED by item 37 (Agent observability dashboard, completed 2026-05-08). Original scope preserved for traceability: dashboard or log query showing all GHL actions by agents in last 24 hours, issue completion rates, agent error rates, spend per agent.

- [ ] **27. Outbound prospecting (optional, Phase 3)**
  Cold email / LinkedIn outreach for SDR agent.
  Requires: Apollo or ZoomInfo integration, email warmup, sequencer logic, reply detection.
  Defer until inbound funnel is proven.

- [ ] **28. ServiceTitan/Jobber integration** — Laura integrates with field service management tools to sync job expenses in real time. Required for Trades page "Receipt Vacuum" feature promise. Research API availability for ServiceTitan and Jobber.

---

## PHASE 4: Accounting API

*Cross-cutting architectural workstream. Builds the production-safe accounting API surface (read + write endpoints) that powers both the bookkeeping agents (HORIZON 3) and Ledgerix Pro's own billing (HORIZON 4 / H4-5). Phased to land safely: read endpoints first, then write endpoints atop a safety layer. See `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md` for active work and `docs/LedgerixPro-Enterprise-Architecture.md` Section 6 for architectural context.*

### Phase 4a: Read endpoints

- [x] **P4a-1. Read endpoints (QBO + Xero)** — Completed: 2026-05-12 (approx). 7 GET endpoints production-ready: `/transactions` (list with pagination), `/accounts` (Chart of Accounts), `/invoices` (list + filtering), `/reports/p-and-l` (P&L + Balance Sheet + Trial Balance extensions), plus internal helpers. Powers the bookkeeping agents' Sentinel run.

### Phase 4b: Write endpoint specification + foundation

- [x] **P4b-1. Write endpoint specification** — Completed: 2026-05-15 (approx). Detailed spec for POST /transactions/:txnId/category, POST /payments, POST /invoices written. Identified gaps that became Phase 4c safety architecture work.
- [x] **P4b-2. Initial write endpoint implementation** — Completed: 2026-05-15 (approx). First-pass write endpoints shipped but flagged for safety hardening before any real client traffic (the "May 11-17 hallucinated email incident" prompted the Phase 4c safety pause).

### Phase 4c: Safety architecture

- [x] **P4c-1. Write approvals service** — Completed: 2026-05-17. New `services/accounting/write-approvals.ts` providing HITL gating for safety-critical writes. Approval flow: agent proposes → human approves → write executes. Audit logged.
- [x] **P4c-2. Pricing engine** — Completed: 2026-05-17. `services/accounting/pricing.ts` + `pricing` DB table with `getExpectedPriceCents(tier, isCharter)` lookup. Seeded with 6 rows covering the tier × charter-state matrix (Foundation / Growth Engine / Scale-Up × Charter / Standard). Powers invoice price validation. Production seed bootstrap completed via Defect 1 fix path; see WIP doc for activity_log entries.
- [x] **P4c-3. Dedupe service** — Completed: 2026-05-17. Idempotency-key-based dedupe for write endpoints. Prevents duplicate invoices/payments on retry.
- [x] **P4c-4. ADR-003 written** — Completed: 2026-05-17. Architecture Decision Record locking the safety pattern: write endpoints sit atop write-approvals + pricing + dedupe + thresholds. Amendment 1 identifies Q1 (charter status storage) + Q2 (setup fee handling) as remaining gaps blocking the Invoice endpoint.
- [x] **P4c-5. PAPERCLIP_ALLOW_EXTERNAL_WRITES kill switch** — Completed: 2026-05-17. Env-var-gated immediate defense against external writes. Routine engine disabled in local_trusted environment as additional safety layer. See `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md` for full incident response context.

### Phase 4c.5: Admin API + Decision 4 + Decision 5 + Q1 + Q2

- [x] **P4c.5-1. Admin pricing/thresholds seed endpoints** — Completed: 2026-05-25. `POST /api/admin/pricing/seed` + `POST /api/admin/thresholds/seed` with bearer-token auth (Lock 1B pattern). Session-only auth currently; CI/CD bearer-token path documented for future deployment automation.
- [x] **P4c.5-2. Defect 1: compareAndSeed null-identity bug** — Completed: 2026-05-26. SQL null-equality bug in `compareAndSeed` helper. Fixed via `value === null ? isNull(col) : eq(col, value)` pattern. Integration tests added against embedded Postgres. Prod-verified via re-run (`audit_log e6d8b7f5-a851-4af9-a5f5-164acc940f95`). Commit `1727746a`.
- [x] **P4c.5-3. Q3 / Decision 4: get-transaction-by-id infrastructure scope LOCKED** — Completed: 2026-05-26. Option A (full coverage) locked: per-type fetch handlers for 7 QBO types + 4 Xero types behind a unified `getTransactionById` interface returning `previousAccountRef`. See WIP doc Decision 4 for the locked interface contract.
- [x] **P4c.5-4. Decision 4 Phase 1** — Completed: 2026-05-26. Dispatcher + 3 of 11 types shipped: QBO Purchase, QBO Bill, Xero BankTransaction. Existing two `updateTransactionAccount` handlers refactored to use the dispatcher. 15 new tests. Commit `bffa3b16`.
- [x] **P4c.5-5. Decision 4 Phase 2 foundation** — Completed: 2026-05-27. Structured `HttpResponseError` class added to qboRequest/xeroRequest; dispatcher's multi-type probing catch tightened to strict discriminator (only 404 continues to next type; everything else rethrows). 3 new tests lock strict semantics. Commit `635e4998`. Test baseline 179 → 182.
- [x] **P4c.5-6. Decision 4 Phase 2 type expansion** — COMPLETE Session 4 (2026-05-27). All 11 planned transaction types now covered by the dispatcher across 6 incremental commits: `8830f206` QBO JournalEntry, `7027c79a` QBO Deposit, `2195544a` QBO BillPayment, `769a39ca` QBO Payment, `bf96d2d3` QBO Invoice (QBO half complete), `4e9d70be` Xero Invoice/Bill/ManualJournal (feature-complete). One mid-implementation revision shipped as commit `fb13f98c` (Decision 4 REVISED note per Tenet #16: Xero serves ACCREC and ACCPAY from the same `/Invoices/{id}` endpoint, requiring a shared handler under two registry keys). Final implementation: 11 type keys / 10 handler functions. Test baseline 161 → 198 (+37 tests).
- [x] **P4c.5-7. Decision 5 (write-side dispatcher scope)** — COMPLETE Session 4 (2026-05-27). LOCKED + FEATURE-COMPLETE. Write-side counterpart to Decision 4 covering 6 of 11 read types via 5 handler functions (Xero Invoice/Bill share `updateXeroInvoiceOrBillAccount`). 5 EXCLUDED types correctly throw `TransactionTypeNotCategorizableError`: QBO BillPayment / Payment / Invoice (not categorization semantics) + QBO JournalEntry / Xero ManualJournal (multi-line journals deferred to Q5). Per Tenet #14 (Trust Tenet) — asymmetry with Decision 4 is by design, matches QBO/Xero API constraints. Implementation arc: locked `07c056e5`, foundation `69505e90`, 5 per-type handlers `d90d5304` / `034ac5c4` / `eb77d817` / `5f30c3b2` / `e7ee3273`. Test baseline 198 → 222 (+24).
- [x] **P4c.5-8. Decision 5 final integration (Piece A)** — COMPLETE Session 4 (2026-05-27, commit `b7da7478`). Extended `updateTransactionCategory` signature with optional `hintedType` parameter (Tenet #16 compliant interface EXTENSION). DELETED legacy `qbo.updateTransactionAccount` + `xero.updateTransactionAccount` methods from `services/accounting/index.ts` plus 5 orphaned local interfaces (~85 lines removed). Zero callers verified before deletion. Single canonical write entry point established. Test baseline 222 → 224 (+2).
- [x] **P4c.5-9. TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS approval wired (Piece B)** — COMPLETE Session 4 (2026-05-27, commit `001d547f`). Replaced Phase 4c.4 stub in `executeApprovedAccountingWrite` with real execution via the Decision 5 dispatcher. Approval execution now replays the original POST request from the payload per ADR-003 Q2 design intent. New `write_failed_replay` action enum value distinguishes "tried but underlying operation failed" from `stub_logged` and `write_executed`. Three outcomes handled: success / still-not-found / type-not-categorizable. Unknown errors propagate. -1 stub test + 4 new tests = +3 net. Test baseline 224 → 227.
- [x] **P4c.5-10. POST /api/accounting/v1/transactions/:txnId/category route (Piece C)** — COMPLETE Session 4 (2026-05-27, commit `bfc8549d`). First Phase 4c.5 write endpoint shipped end-to-end. Validates URL+body params, `assertCompanyAccess`, `withIdempotency` wrapping (ADR-003 Q5 compliance), three response paths (200 success / 202 approval / 400 not categorizable). FK safety fix caught pre-commit: separated `requestedByUserId` / `requestedByAgentId` per actor type to prevent agent IDs being written to a users-FK field in production. +6 tests (5 originally planned + 1 agent-actor test from the FK fix). Test baseline 227 → 233.
- [x] **P4c.5-11. Q1: Charter status storage** — LOCKED + IMPLEMENTED Session 4 (2026-05-27). Option B chosen — local DB table `client_charter_status` per Trust Tenet #14 (billing source-of-truth in our own DB, structural enforcement of the cancellation-forfeits-Charter rule via the status enum). Shipped: lock commit `0cf679d6` (docs), implementation commit `5b4856bb` (schema + service + 20 tests). New migration `0068_youthful_blockbuster.sql`. Service module `server/src/services/accounting/charter.ts` exports `getCharterStatus`, `isCharterForInvoicing`, `grantCharterToNewClient`, `recordNonCharterClient`, `cancelCharter` + 3 typed error classes. State-transition rules enforced at service layer. Test baseline 233 → 253 (+20). Deferred work (tracked in WIP doc): onboarding workflow integration, cancellation workflow integration, Invoice endpoint wiring.
- [x] **P4c.5-12. Q2: Setup fee handling** — LOCKED + IMPLEMENTED Session 4 (2026-05-27). Option B chosen — parallel `setup_fee_pricing` table (no isCharter, no contactId per EA Section 7). Aligns with Q1's "separate, structurally-correct modeling" design principle. Shipped: lock commit `0cf679d6` (docs alongside Q1), implementation commit `83b80a72` (schema + service + admin seed extension + 9 net tests). New migration `0069_damp_bloodscream.sql`. Service function `getSetupFeeCents(db, tier)` added to `server/src/services/accounting/pricing.ts`. Seed values from EA Section 7: Foundation $249 / Growth Engine $349 / Scale-Up $1,200. Admin endpoint `POST /api/admin/pricing/seed` extended to combined response shape `{ data: { pricing: {...}, setupFees: {...} }, meta }` (sub-decision Q2-α-i locked during implementation; 3 existing admin tests updated for the new shape). Test baseline 253 → 262 (+9). Deferred work (tracked in WIP doc): Invoice endpoint wiring, production seed invocation.
- [ ] **P4c.5-13. Q5: Multi-line journal write semantics** — Architectural decision pending. Surfaced during Decision 5 scoping Session 4 (2026-05-27). QBO JournalEntry + Xero ManualJournal category updates require Debit/Credit balance preservation; updating one line's AccountRef without offsetting changes breaks journal balance. The architectural problem requires its own decision — how does the caller express intent (preserve balance, update offsetting lines, dual-AccountRef in request)? Current behavior: handler-level exclusion correctly routes to `TransactionTypeNotCategorizableError`. See `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md` Decision 5 → "Out of scope for Decision 5 (deferred)" subsection.
- [ ] **P4c.5-14. POST /payments re-implementation** — 2-3 hours. Atop safety layer (thresholds); awaits service signature fixes. Gated on Q2.
- [ ] **P4c.5-15. POST /invoices re-implementation** — 3-4 hours. Atop safety layer (pricing + dedupe); blocked on Q1 + Q2.

### Phase 4 success criteria (lock from ADR-003)

- All write endpoints atop the safety layer (approvals + pricing + dedupe + thresholds) before any real client traffic.
- `getTransactionById` covers all 11 transaction types across QBO + Xero so write endpoints can capture `previousAccountRef` for audit trails.
- Q1 + Q2 resolved before Invoice endpoint ships.
- Test coverage discipline: integration tests against embedded Postgres for any SQL-level work (lesson from Defect 1).

---

## HORIZON 4: Client Portal & Revenue Expansion

- [x] **H4-1. Client portal** — api.ledgerixpro.com/portal/{contactId} — client-facing light-theme portal showing this month's metrics (transactions, categorized, reconciled, flagged), book status (current/attention_needed/unknown), and 4-week history. No auth for beta (contactId as token). Built into Dockerfile. Completed: 2026-05-09

- [x] **H4-2. AP Specialist agent** — daily 6:30am scan (7-day warnings to client, overdue 1-29d → CFO + Health Monitor, overdue 30d+ → CFO + Health Monitor + Senior Bookkeeper + Scott). Weekly Monday 8:30am HTML AP summary to clients. getBills added for QBO + Xero. Correct escalation chain through CFO and Senior Bookkeeper. Completed: 2026-05-08
- [x] **H4-3. Tax Liaison agent** — daily 7am scan (7-day alerts + CPA handoff issue), weekly Monday 9am 30-day planning emails with YTD P&L summary. Federal + Arizona state deadlines. Completed: 2026-05-09
- [x] **H4-4. Reporter agent** — weekly pulse Monday 7:30am (MRR, active clients, HITL queue, agent errors), monthly deep dive 1st of month 7am (full business metrics, bookkeeping rates, client health, next month priorities). Email to scott@ledgerixpro.com + Paperclip issue. Completed: 2026-05-09
- [x] **H4-5. Billing & Invoicing agent** — monthly 1st of month 8am cron, creates QBO invoices in Ledgerix Pro's own QBO, emails clients with payment link, charter-pricing tag controls pricing ($199/$399/$799 Charter, $299/$499/$899 Standard), SMS billing summary to Scott. Completed: 2026-05-08
- [x] **H4-6. Payroll agent** — bi-weekly Wednesday 7am scan (payroll-run verification, 941 federal deposit check, AZ withholding check, 1099-vs-W2 misclassification check), 1st-of-month 11:30am monthly review (full payroll audit, W-2 deadline tracking Dec/Jan, FUTA tracking, A1-QRT quarterly reconciliation, payroll provider verification, monthly report email). Monitors payroll posted to QBO/Xero — does not run payroll directly (clients use Gusto/ADP/Paychex). Escalates via Senior Bookkeeper → CFO → Scott chain. Completed: 2026-05-10
- [x] **H4-7. Quality Control agent** — Mon-Fri 7:30am daily spot-check (20% sample of yesterday's Ledger Specialist runs, categorization/duplicate/anomaly checks, KB coverage), Friday 9am weekly review (trend analysis vs healthy benchmarks, KB health, recommendations email to Scott). Escalates to Senior Bookkeeper or KB Manager. Completed: 2026-05-10
- [x] **H4-8. Audit & Compliance agent** — Mon 10:15am weekly scan (1099 tracking, AZ TPT, AZ ROC contractor licenses, expense documentation), 1st-of-month 11am monthly deep scan (full 1099 audit, TPT review, business licenses, insurance verification, estimated tax payments, monthly compliance report email). Escalates via Senior Bookkeeper → CFO → Scott chain (no direct Scott emails). Completed: 2026-05-10
- [ ] **H4-9. Sales Outreach agent** — cold outbound via Apollo/ZoomInfo, defer until 50+ inbound leads proven
- [x] **H4-10. Referral & Reviews agent** — Tuesday 9am weekly scan identifies 30-day check-in candidates (Scott-signed personal email + Google review request via GOOGLE_PLACE_ID link) and 90-day referral candidates (referral ask email, no formal incentives). Skips clients with open HITL/AP/tax issues. Uses GHL tags review-requested/referral-requested for one-shot tracking, review-received tag for acknowledgment. Completed: 2026-05-10
- [x] **H4-11. AR payment date automation** — confirmed date capture from client replies, history-based prediction (avg days late over 12 invoices), manual update via PAYMENT_DATE: comment, payment received recalibration. Escalation: Senior Bookkeeper → CFO → Scott. Added to AR Specialist AGENTS.md. Completed: 2026-05-10
- [ ] **H4-12. Scale Pattern — accounting webhooks** — webhook renewal cron, queue-based processing, dead letter handling (trigger: 50 clients)
- [ ] **H4-13. Knowledge Base rules DB table** — replace KB-as-issue with dedicated table (trigger: 50 clients)
- [ ] **H4-14. Multi-tenant architecture** — GHL OAuth Marketplace App, per-client Paperclip workspace (trigger: 20 clients)
- [x] **H4-15. Always-on infrastructure** — Paperclip migrated to Railway. api.ledgerixpro.com → Railway (ledgerix-pro-core-production.up.railway.app). PostgreSQL on Railway. All 25 agents seeded. 6 routines registered. Board API key: <PAPERCLIP_BOARD_API_KEY> (set in Railway env). Auth: admin@ledgerixpro.com. Dockerfile with non-root paperclip user (UID 1001) for Claude CLI --dangerously-skip-permissions support. ANTHROPIC_API_KEY required (quotes stripped from all Railway env vars). Agent execution confirmed working — Onboarding agent completed successfully on 2026-05-09. Completed: 2026-05-09

---

## Technical Debt

- [ ] RESET.md Section 9 diagnostic table still references .env file for secret management — update to reflect Railway env vars (dashboard, not file) for production troubleshooting context.

---

## Completed ✅

- [x] Paperclip running locally at localhost:3100
- [x] 25 agents seeded with permissions locked (Client Health Monitor added during HORIZON 2 build, 2026-05-03)
- [x] C-Suite budget guardrails set (verify amounts — see item 13)
- [x] GHL webhook receiver at /api/webhooks/ghl with dual-path auth (shared secret + HMAC fallback)
- [x] Dispatcher routing table in server/src/services/dispatcher.ts
- [x] Workspace registry mapping GHL location GhnRONQQVJiCKsdWoQFc → Paperclip company f60117de-1131-433c-934f-3fe88bfaa163
- [x] RESET.md recovery runbook (Sections 1–11)
- [x] GHL_SCHEMA.md custom field schema (7 fields, internal IDs, write/read asymmetry documented)
- [x] GHL Private Integration token configured (GHL_PRIVATE_TOKEN in .env)
- [x] GHL service module built (server/src/services/ghl/ — client, contacts, types, index)
- [x] Agent bridge built (server/src/services/ghl/agent-bridge.ts)
- [x] Onboarding agent configured (claude_local, claude-sonnet-4-6, AGENTS.md at agents/onboarding/AGENTS.md)
- [x] Onboarding agent validated across 4 test cases (strong ICP, empty, non-ICP, ambiguous)
- [x] GHL Contact Created → Onboarding agent end-to-end pipeline operational
- [x] ngrok hostname allowlisted in Paperclip
- [x] **6. Delete all test contacts in GHL** — Completed: 2026-04-29
- [x] Reply detection — contact.replied webhook → Laura wakes, classifies sentiment, sends personalized reply with booking link, notifies scott via SMS and laura@ledgerixpro.com via email. Completed: 2026-05-02
  Mike Torres, Jordan Smith, Sarah Chen, Carlos Rivera, Laura Hansbury, Breanna Hansbury, Scott Hansbury + any other test records.
  Leaving them will trigger real downstream automations when SDR and onboarding workflows go live.
- [x] Opportunity Won workflow — CSM agent wired, GHL workflow published, client pipeline created (EOq8U8BCqRMX9kM5g2qS), welcome email from scott@ledgerixpro.com via Outlook sync. Completed: 2026-05-02
- [x] Reply detection — contact.replied → Laura classifies sentiment, sends personalized reply (diagnostic link first, then booking link), SMS notification pending A2P. Completed: 2026-05-02
- [x] Diagnostic URL fixed — all Email 2 templates updated to api.ledgerixpro.com/diagnostic. Completed: 2026-05-02
- [x] Email 2 conditional logic — skips diagnostic CTA if contact already has diagnostic-completed tag. Completed: 2026-05-02
- [x] Laura persona — SDR agent renamed from Michael to Laura throughout, sends from laura@ledgerixpro.com. Completed: 2026-05-02
- [x] Opportunity Lost (Sales) workflow — CSM agent handles lost prospects: tags updated, gracious lost email from scott@ledgerixpro.com, 6-month nurture sequence tagged, SMS notification. GHL workflow published. Completed: 2026-05-03
- [x] Client Churn workflow — CSM agent handles churned clients: tags updated, churn email from scott@ledgerixpro.com, churn pipeline opportunity created, SMS notification. GHL workflow published. Completed: 2026-05-03
- [x] All agent timeouts bumped to 240s — SDR and CSM both updated in DB and RESET.md. Completed: 2026-05-03
- [x] Client Health Monitor agent — event-driven health alerts for invoice.overdue, accounting.stale, nps.low. Routes to CRO, moves contacts to At Risk stage, SMS notification. Weekly heartbeat deferred until 5 active clients. Completed: 2026-05-03
- [x] AR Specialist agent — 3-touch invoice collection sequence (7/14/30 days), bill.due internal visibility, escalates to CRO at 30 days, SMS + at-risk tagging. Completed: 2026-05-03
- [x] Invoice Paid webhooks — QBO (CloudEvents format, ahead of May 15 deadline) and Xero (ITR handshake verified) both live. Auto-dispatches invoice.paid → AR Specialist. Growth pattern implemented (auto-register on OAuth). Completed: 2026-05-03
- [x] Backup Recovery Runbook — RESET.md Section 31 added. Step-by-step recovery from Railway container backups at /home/paperclip/.paperclip/instances/default/data/backups/ (filename pattern paperclip-YYYYMMDD-HHMMSS.sql.gz). Covers list/identify/download/restore/verify/post-restore-health with explicit destructive-action warnings. Completed: 2026-05-11

---

*Last updated: 2026-05-27 (Phase 4 section added; status corrections; structural cleanup of duplicate HORIZON labels)*
*Project root: /Users/scotthansbury/Projects/ledgerix-pro-core*
*Maintained alongside `docs/wip/`, `docs/PHASE-4-PROGRESS.md`, `docs/LedgerixPro-Enterprise-Architecture.md`, and `docs/LedgerixPro-Claude-Project-Brief.md`*
