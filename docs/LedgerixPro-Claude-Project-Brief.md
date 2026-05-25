# Ledgerix Pro — Claude Project Brief

**Version 1.4 — May 24, 2026 — CONFIDENTIAL**

Context document for AI assistant — optimized for fast loading.

> **Purpose of this document:** You are assisting Scott Hansbury, Founder & Business Strategist of Ledgerix Pro — an AI-powered autonomous bookkeeping firm deployed on Railway cloud. This brief gives you everything you need to assist without re-explanation. Read it fully before responding to any Ledgerix Pro question.

---

## 1. Who & What

| Key | Value |
|---|---|
| Founder | Scott Hansbury — scott@ledgerixpro.com / admin@ledgerixpro.com |
| Company | Ledgerix Pro LLC — AI-powered bookkeeping firm |
| Location | Scottsdale / Phoenix, Arizona |
| Stage | Pre-beta — pipeline ready, no active beta clients pending Pattern B Full Phase 5 |
| Codebase | `/Users/scotthansbury/Projects/ledgerix-pro-core` (local) \| `github.com/LedgerixPro/ledgerix-pro-core` (private) |
| Live URL | https://api.ledgerixpro.com |
| Dashboard | https://api.ledgerixpro.com/dashboard |
| Dashboard Secret | `e877bb00219cd8758269d397743906d8995144ff7e4c2f9a69741574672e894c` |
| Paperclip Company ID | `f60117de-1131-433c-934f-3fe88bfaa163` |
| Board API Key | `pcp_board_railway_admin_key_2026` |
| GHL Location ID | `GhnRONQQVJiCKsdWoQFc` |
| Railway DB | `postgresql://postgres:TsZlqUCeemXLEDyIHBwOcgmdeGSoTkKS@turntable.proxy.rlwy.net:32057/railway` |

### 1.1 Trust Tenet (established 2026-05-24)

No real clients — including Ledgerix Pro's own books — onboarded until the system is correct, trustworthy, and dialed in for security and safety of client funds. Applies uniformly. No partial-spec compliance on safety-critical write endpoints. Time is reference for planning, not a gate for go/no-go decisions.

**Operating Principles** (encoded in `CLAUDE.md` at repo root):

- Verify before assuming (grep callers, view imports, read authoritative docs before quoting)
- Session-end documentation discipline (EA + Brief + trackers + WIP docs always reflect committed reality)
- Locked decisions stay locked (no re-litigation across sessions)
- WIP docs (`docs/wip/`) are TRUTH for active multi-session work

**WIP Convention:** Multi-session architectural work has documents at `docs/wip/<feature>.md` capturing locked decisions, pending questions, rejected options, and append-only session logs. Read `docs/wip/README.md` for the convention.

---

## 2. Tech Stack at a Glance

| Layer | Technology | Status |
|---|---|---|
| Agent Orchestration | Paperclip AI (`claude_local` adapter, `claude-sonnet-4-6` model) | Live on Railway |
| Infrastructure | Railway cloud — auto-deploys on git push to master | Live |
| Database | External PostgreSQL on Railway | Live |
| CRM | GoHighLevel (GHL) | Live |
| Accounting | Xero (multi-tenant per-contact OAuth) + QBO (built, pending client) | Xero live |
| Language | TypeScript / Node.js (ESM, pnpm monorepo) | Live |
| DB Backups | Hourly automated `.sql.gz` snapshots in Railway container | Live |
| Client Portal | `api.ledgerixpro.com/portal/{slug}` or `/{contactId}` | Live |
| Xero Webhook | Registered at developer.xero.com — Invoices, Contacts, Credit Notes | Live, OK |
| A2P SMS | GHL Trust Center approval pending | Pending |
| Google Place ID | Claim Google Business profile first, then add to Railway env vars | Not yet set |

> **⚠ RAILWAY CRITICAL:** Never wrap Railway env var values in quotes. `KEY=value` not `KEY="value"`. Quoted values broke `ANTHROPIC_API_KEY` auth. This has caused failures before.

---

## 3. Agent Roster (18 Active of 25 Configured)

| Division | Agents | Key Schedules |
|---|---|---|
| Accounting (CFO) | Senior Bookkeeper, Ledger Specialist, Reconciliation Agent, AP Specialist, AR Specialist, Payroll, Reporter, Tax Liaison, Billing & Invoicing | Sentinel 6am daily; AP 6:30am daily; Tax 7am daily; Senior Bookkeeper digest Mon 8am |
| Operations (COO) | Sentinel, Onboarding, Quality Control, Audit & Compliance, Knowledge Base Manager | QC spot-check 7:30am Mon-Fri; QC weekly Fri 9am; Audit & Compliance Mon 10:15am |
| Revenue (CRO) | SDR (Laura), Client Success Manager, Referral & Reviews, Reactivation | Referral & Reviews Tue 9am; Reactivation 1st of month 9am |
| Dormant | Client Health Monitor (enable at 5 paying clients), Sales Outreach (50+ leads) | Client Health Monitor cron: `0 15 * * 1` (Mon 8am Arizona) |

---

## 4. Build Status

| Horizon / Phase | Status | Summary |
|---|---|---|
| H1 Foundation | Done | GHL webhooks, Paperclip setup, dual-path auth, workspace registry |
| H2 Accounting Core | Done | Xero + QBO OAuth, Sentinel, Ledger Specialist, Reconciliation, Senior Bookkeeper, KB Manager |
| H3 Operations | Done | Dashboard, weekly digest, budget guardrails, diagnostic CRO funnel, nurture, SDR Laura, Reactivation |
| H4 Full Platform | Done | Client portal (slug URLs), 6 new agents, Railway migration, multi-tenant OAuth (H4-14), AR payment date intelligence |
| Phase 4 Accounting API | In progress | 5 of 8 endpoints production-ready. Write endpoints (transactions/category, payments, invoices) deferred behind Phase 4c safety architecture. |
| Phase 4c Safety Architecture | In progress | 4 of 5 pieces complete: pricing source of truth, threshold framework, customer dedupe with HITL, write-approval dispatcher (stub mode). Phase 4c.5 in progress — see `docs/wip/phase-4c-5-write-endpoints-and-admin-api.md` |
| H4 Deferred | Scale | Sales Outreach (50+ leads), Scale Pattern (50 clients), KB rules DB table |

---

## 5. Critical IDs & References

### Agent IDs (Key Agents)

| Agent | Paperclip ID |
|---|---|
| Onboarding | `2ae62352-b235-417f-ae97-99df11414ebb` (maxTurnsPerRun: 40) |
| SDR (Laura) | `2b4d27f8-5893-481c-a984-9203f4f1af8e` |
| All others | Query: `SELECT id, name FROM agents WHERE company_id = 'f60117de-...' ORDER BY name` |

### Beta Clients

No active beta clients. Enyrgy Inc will be onboarded through the production pipeline once Pattern B Full Phase 5 ships.

### GHL Custom Fields & Pipelines

| Field / Pipeline | ID |
|---|---|
| `service_tier` field | `Dh5rwdlahz6a37BAQDIs` |
| `client_type` field | `Cf539co3LHJrm6wLAJQJ` |
| `ledgerix_workspace_id` field | `vmAT4OjG10QboXA2Jqjs` (vestigial post-H4-14, retained for compat) |
| `nurture_month` field | `sMQegZrU2giDsyaNKnjt` |
| Sales Pipeline | `dtgrQV0u9DB5EmxJGY9K` |
| Clients Pipeline | `EOq8U8BCqRMX9kM5g2qS` |
| Churn Pipeline | `A4SSmXmDnwPKGfxKcvut` |

### Phase 4c Safety Architecture

Every write endpoint (`POST /transactions/:txnId/category`, `POST /payments`, `POST /invoices`) sits atop the Phase 4c safety layer. Endpoint flow: validate → safety checks → if pass: upstream write + audit + idempotency; if fail: create approval (202 Accepted) + audit + idempotency.

**Components shipped (as of 2026-05-24):**

- **Pricing source of truth (4c.1)** — `service_tier_pricing` + `client_pricing_overrides` tables; `getExpectedPriceCents(db, tier, isCharter, contactId?)` service function. Effective-dating throughout.
- **Threshold framework (4c.2)** — `write_thresholds` table; `getApplicableThresholds`, `getMostSpecificThreshold`, `isThresholdExceeded` service functions. Hierarchical: per-client overrides win over global defaults.
- **Customer dedupe with HITL (4c.3)** — `findOrCreateCustomer` returns `{customerId, action}` where action is one of 5 types (3 auto-proceed, 2 require approval). String-similarity utility (Levenshtein + name normalization).
- **Write-approval dispatcher (4c.4, stub mode)** — `services/accounting/write-approvals.ts`. 4 dot-namespaced approval types (`accounting.payment.threshold_exceeded`, `accounting.invoice.dedupe_ambiguous`, etc.) with typed payloads. Wired into `approvalService.approve()` for routing.

**In progress:** Phase 4c.5 — admin endpoints for safety-layer data management + re-implementing the three write endpoints atop the safety layer. See WIP doc for current state.

### Architectural Decision Records

- **ADR-001:** Pattern B Full API endpoints
- **ADR-002:** Phase 4b write endpoint design (idempotency, audit, two-phase failure)
- **ADR-003:** Phase 4c safety architecture (10 decisions, 3 amendments)

---

## 6. Service Tiers & Pricing

Updated May 17, 2026. Growth Engine Standard moved from $499 to $599 and Scale-Up repriced to $999/$1,299 to match market positioning for specialist trades and agency bookkeeping. First 10 clients receive Charter pricing.

| Tier | Target | Charter | Standard | Key Features |
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

### Tier Qualifiers

Industry framing drives the marketing pitch; the qualifiers below drive the price quoted at the discovery call. Most qualifiers must match to land in a given tier; if a client splits across tiers (e.g. Growth Engine on volume but Scale-Up on entity count), price to the higher tier.

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

---

## 7. Architecture Patterns to Know

### Multi-Tenant OAuth (H4-14)

- Each client has their own Xero/QBO connection keyed by GHL `contact_id` in `accounting_connections` table
- Connect URL: `https://api.ledgerixpro.com/api/oauth/xero/connect?contactId={ghlContactId}`
- All agents call: `getNewTransactions(db, COMPANY_ID, contact.id, sinceDate)`
- Unique constraint: `(company_id, platform, contact_id)` with `NULLS NOT DISTINCT`

### Slug-Based Client Portal

- `https://api.ledgerixpro.com/portal/{company-slug}` → 302 redirect → `/portal/{contactId}`
- Slug = company name lowercased, spaces → hyphens, special chars stripped. Automatic for all clients.

### Escalation Chain (All Agents)

**Senior Bookkeeper → CFO → Scott**

No agent contacts Scott directly for routine issues. Scott only for Level 3 events (fraud, breach, cancellation).

### Webhook & Agent Trigger Flow

- GHL fires webhook → `/api/webhooks/ghl` → Dispatcher → Paperclip creates issue → Agent wakes up
- Key events: `contact.created`, `contact.updated`, `contact.sdr_ready`, `contact.replied`
- Agents discriminate mode by issue title (e.g. 'Weekly QC Review' vs daily, 'Monthly Payroll Review' vs bi-weekly)

---

## 8. Scale Triggers

| Trigger | Action |
|---|---|
| 5 paying clients | Enable Client Health Monitor: cron `0 15 * * 1` (Monday 8am Arizona / 15:00 UTC). Register at `/companies/f60117de.../routines` |
| 10 clients | Charter pricing window closes — new clients move to Standard pricing |
| Each 25-client milestone | Revisit agent budget caps (~$1,225 at 25, ~$3,110 at 75, ~$5,480 at 150, ~$9,700 at 300) |
| ~50 leads | Enable Sales Outreach agent (H4-9) |
| ~50 clients | Scale Pattern webhooks + KB rules DB table (H4-12/13) |

---

## 9. Database Migrations

Current migration head: `0067_last_gateway.sql`

Recent migrations relevant to Phase 4 work:

- `0064` — `activity_log.status` column + `idempotency_keys` table (Phase 4b foundation)
- `0065` — `service_tier_pricing` + `client_pricing_overrides` (Phase 4c.1)
- `0066` — `write_thresholds` (Phase 4c.2)
- `0067` — `activity_log.company_id` nullable for system-scoped admin operations (Phase 4c.5 Decision B)

---

## 10. Test Status

Current targeted test baseline: **145 tests passing**

- 62 accounting routes
- 14 idempotency
- 10 pricing (4c.1)
- 14 thresholds (4c.2)
- 25 string-similarity (4c.3)
- 9 findOrCreateCustomer (4c.3)
- 11 write-approvals (4c.4)

**Note on full suite:** Running `pnpm exec vitest run` (entire server, 1240 tests) has known flakiness in unrelated `workspace-runtime.test.ts` due to parallel-run resource contention. Same tests pass cleanly when run in isolation. Pre-existing infrastructure issue unrelated to Phase 4c work. Verified 2026-05-24.

---

## 11. Open / Pending Items

- **A2P SMS** — GHL Trust Center approval pending (Laura's SMS outreach queued, email works fine)
- **Google Business Profile** — claim at business.google.com, then add `GOOGLE_PLACE_ID` to Railway env vars
- **Client portal auth** — add proper token auth when first paying client requests portal access
- **Xero bank transactions** — NOT available as webhook events (Xero limitation). Sentinel daily 6am poll handles these.

---

## 12. How to Help Scott Effectively

- Scott uses Claude Code for all code changes — give complete, ready-to-paste instructions
- Always check Railway env var syntax: no quotes around values (`KEY=value` not `KEY="value"`)
- `RESET.md` in repo root is the authoritative recovery runbook — reference it for infrastructure questions
- `AGENTS.md` files in `agents/{name}/` are authoritative for agent behavior — suggest edits there for behavioral changes
- When creating Paperclip issues via API: POST to `/api/companies/{companyId}/issues` with `assigneeAgentId` and `status: in_progress`
- Onboarding agent has `maxTurnsPerRun: 40` in DB — if it fails with `error_max_turns`, UPDATE in DB, not code
- Scott's background: CFO at multiple companies, CEO of Enyrgy, VP Marketing/Biz Dev — speak at executive + technical level
- All 17 cron routines are live and firing. 18 active agents. H1-H4 complete.

---

**LEDGERIX PRO — CONFIDENTIAL**

Scott Hansbury | Founder & Business Strategist | Version 1.4 | May 24, 2026
