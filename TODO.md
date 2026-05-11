# Ledgerix Pro — Master Task List

Priority-ordered build list. Updated: 2026-05-01.

---

## HORIZON 1: Pre-Launch
*Must complete before first paying client.*

- [x] **1. Build the GHL diagnostic survey** — Completed: 2026-05-01
  Diagnostic calculator live at /diagnostic. Calculates Stun Value for Trades/Agency/Small Business.
  Writes diagnostic_amount + service_tier to GHL contact on submission.

- [ ] **2. Wire the SDR agent**
  `sdr-ready` contacts are queuing with no agent acting on them.
  Needs: GHL workflow trigger (tag added = sdr-ready), dispatcher route, AGENTS.md, claude_local config, outbound GHL messaging.

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

## HORIZON 2 — Complete ✅ (2026-05-03)
*Complete after first client, before scale.*

- [ ] **7. Wire the Opportunity Won workflow**
  GHL trigger: Opportunity Stage → Won.
  Actions: create client workspace in Paperclip, initiate QBO/Xero connection, assign CS agent, send welcome materials.

- [ ] **8. Wire the Opportunity Lost workflow**
  GHL trigger: Opportunity Stage → Lost.
  Actions: trigger win-back nurture, update ICP Status, log loss reason, feed pipeline analytics.

- [ ] **10. Build the CS / Client Success agent**
  Post-close agent. Monitors client health, collects NPS (writes `contact.nps_score`), detects churn risk.
  Triggers on: NPS survey submission, missed invoice, engagement drop.

- [ ] **11. Build the Billing / AR agent**
  Monitors invoice status in QBO/Xero.
  Invoice paid → update GHL contact, log to Paperclip.
  Invoice overdue → trigger follow-up sequence.

- [ ] **12. Build the Invoice Paid GHL webhook workflow**
  New GHL workflow: trigger = Invoice Paid → webhook to Paperclip with `event: invoice.paid`.
  Dispatcher route to Billing agent. Requires QBO/Xero integration (#3 above).

---

## HORIZON 3 — Bookkeeping Engine

- [x] **29. Sentinel agent** — daily transaction puller, cron 0 6 * * * America/Phoenix, routine registered. Completed: 2026-05-08
- [x] **30. Ledger Specialist agent** — categorizes transactions, reads KB rules, HITL ≥$1,000, enqueues Reconciliation. Completed: 2026-05-08
- [x] **31. Reconciliation agent** — matches bank transactions to invoices, HITL ≥$999.99, triggered by Ledger Specialist. Completed: 2026-05-08
- [x] **32. Senior Bookkeeper agent** — claude-opus-4-7, three-tier HITL ($1k/$10k), writes back to QBO/Xero, enqueues KB Manager. Completed: 2026-05-08
- [x] **33. Knowledge Base Manager agent** — builds client-specific categorization rules, additive KB-as-issue design. Completed: 2026-05-08
- [x] **34. QBO/Xero write-back API methods** — updateTransactionCategory, reconcilePayment, applyPaymentToInvoice for both platforms. Completed: 2026-05-08

- [ ] **35. Wire KB consumption into Ledger Specialist** — DONE (completed inline during bookkeeping engine build 2026-05-08)
- [ ] **36. knowledge_base_rules DB table** — replace KB-as-issue design with a dedicated table at scale (50+ clients). Defer to Scale Pattern work.
- [x] **37. Agent observability dashboard** — internal dashboard live at api.ledgerixpro.com/dashboard. Secret-gated, 30s auto-refresh, agent health grid, HITL queue, active clients. Backend + frontend complete. Completed: 2026-05-08
- [x] **38. Weekly client email digest** — Senior Bookkeeper sends branded HTML Monday 8am digest to all active clients. Metrics from runMetrics (transactions, categorized, reconciled, reviewed). Skips clients with no activity. Routine registered. Completed: 2026-05-08
- [x] **39. Structured execution state** — run_metrics jsonb column added to issues table (migration 0061), runMetrics field in createIssueSchema/updateIssueSchema, all four bookkeeping agents updated to PATCH runMetrics at end of each run. Dashboard reads real counts tomorrow after 6am Sentinel run. Completed: 2026-05-08

## HORIZON 3: Scale & Hardening
*Post-launch, post-first-10-clients.*

- [ ] **16. Move to production infrastructure**
  Railway, Fly.io, or similar. Stable URL, TLS, uptime monitoring, auto-restart.

- [ ] **17. Upgrade GHL to OAuth Marketplace App**
  Required if client data lives in their own GHL sub-accounts.
  Full OAuth flow, per-location token storage, automatic refresh.
  See architecture notes: Pattern X → Pattern Y upgrade path.

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

- [ ] **26. ~~Build agent audit trail / observability~~** — superseded by item 37 (Agent observability dashboard). Original scope: dashboard or log query showing all GHL actions by agents in last 24 hours, issue completion rates, agent error rates, spend per agent.

- [ ] **27. Outbound prospecting (optional, Phase 3)**
  Cold email / LinkedIn outreach for SDR agent.
  Requires: Apollo or ZoomInfo integration, email warmup, sequencer logic, reply detection.
  Defer until inbound funnel is proven.

- [ ] **28. ServiceTitan/Jobber integration** — Laura integrates with field service management tools to sync job expenses in real time. Required for Trades page "Receipt Vacuum" feature promise. Research API availability for ServiceTitan and Jobber.

---

## HORIZON 4

- [x] **H4-1. Client portal** — api.ledgerixpro.com/portal/{contactId} — client-facing light-theme portal showing this month's metrics (transactions, categorized, reconciled, flagged), book status (current/attention_needed/unknown), and 4-week history. No auth for beta (contactId as token). Built into Dockerfile. Completed: 2026-05-09

---

## HORIZON 4 — Scale & Revenue Expansion

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

*Last updated: 2026-05-11*
*Project root: /Users/scotthansbury/Projects/ledgerix-pro-core*
