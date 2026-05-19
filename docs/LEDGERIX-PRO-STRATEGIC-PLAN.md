# Ledgerix Pro — Strategic Plan

**Version:** 1.0
**Date:** May 16, 2026
**Author:** Scott Hansbury, Founder
**Status:** Approved — foundational reference document

## Purpose of this document

This document captures the strategic identity, scale target, and operational philosophy of Ledgerix Pro. It exists to:

1. Anchor every architectural and engineering decision to a clear business plan
2. Document the lifestyle-business positioning that differentiates Ledgerix Pro from venture-funded competitors
3. Serve as the founder-level reference for "why we do things this way"
4. Surface pre-launch operational requirements that don't fit inside technical design docs

Technical specifications for individual phases live in separate documents. See `PHASE-4-ACCOUNTING-API-SPEC.md` for the current build's technical detail.

## Strategic Context

Ledgerix Pro is a lifestyle bootstrap business. No outside investment, no exit ambitions, no hyper-growth target. The architecture and engineering investments described in supporting technical documents are calibrated for this strategic identity. Decisions that would only make sense for a venture-funded growth-at-all-costs play are deliberately out of scope.

### Scale target at maturity

- 50 clients
- ~$29,230/month gross monthly recurring revenue [TODO: recompute with new pricing — Growth Engine $599 and Scale-Up $1,299]
- ~$30,114/month total revenue (including ~$884/month setup fees from steady-state new client acquisition) [TODO: recompute with new pricing]
- ~$285k/year founder net income [TODO: recompute with new pricing and cost-side assumptions]
- Operational team: founder + 1 US-based lead contractor (~10 hrs/week) + 1 offshore bookkeeper (~25 hrs/week)

### Pricing structure

**Monthly recurring (Standard pricing):**
- Foundation tier: $299/month — freelancers and micro-businesses
- Growth Engine tier: $599/month — local trades and service businesses
- Scale-Up tier: $1,299/month — agencies and law firms

**Charter pricing (first 10 paying clients only):**
- Foundation: $199/month
- Growth Engine: $399/month
- Scale-Up: $999/month

**One-time setup/migration fees (all clients, including Charter — no waivers):**
- Foundation: $249
- Growth Engine: $349
- Scale-Up: $1,200

Setup fee covers: chart of accounts review, vendor categorization rules, platform connection, workflow training, and (for non-QBO/Xero prospects) data migration. Variance between clean-setup and full-migration work is absorbed into the single fee structure for v1; future iteration may split setup-only vs. setup+migration tiers if margin analysis warrants.

**Target client mix at 50 clients:**
- 10 grandfathered Charter pricing clients (~$419/month blended average) [TODO: recompute with new Charter pricing — Scale-Up Charter now $999]
- 15% Foundation tier (new acquisition de-emphasized after first 10 clients)
- 55% Growth Engine tier
- 30% Scale-Up tier
- Blended average revenue per new client: ~$626/month [TODO: recompute with new Standard pricing — Growth Engine $599 and Scale-Up $1,299]

### Tier qualification model

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

**Charter Pricing Window**

Charter pricing applies to the first 10 paying clients only. After client #10, the Charter column closes and new clients onboard at Standard pricing.

**Charter benefit follows the client across tiers.** As long as service is continuous, Charter clients keep Charter pricing for the duration of their relationship with Ledgerix Pro — even as their business grows from one tier to the next. A Foundation Charter client whose qualifiers move them to Growth Engine pays Growth Engine Charter ($399/mo), not Standard ($599/mo). Same applies for Scale-Up: Charter clients who grow into Scale-Up pay Scale-Up Charter ($999/mo), not Standard ($1,299/mo). The benefit also applies on tier downgrades: a Scale-Up Charter client whose qualifiers shrink to Growth Engine pays Growth Engine Charter, not Standard.

**Continuity rule:** if a Charter client cancels service and later returns, they re-enter at Standard pricing for whichever tier they qualify for. The Charter benefit is granted to the first 10 paying clients as a thank-you for choosing Ledgerix Pro early; it is not transferable, sellable, or recoverable after cancellation.

For the authoritative qualifier definitions and edge cases, see Enterprise Architecture v3.2 Section 7.1.

### Client platform requirement

All Ledgerix Pro clients must use either Xero or QuickBooks Online as their accounting platform. During sales qualification, prospects are asked: "Are you on QBO or Xero, or are you willing to move to QBO or Xero?" Migration support during onboarding is offered for qualifying prospects who commit to migrating. Prospects unwilling to use one of these two platforms are not eligible. This requirement is baked into qualification, onboarding, and architectural assumptions.

### Ledgerix Pro's own books — accounting platform

Ledgerix Pro LLC uses **QuickBooks Online (QBO)** for its own company books. This is a deliberate architectural decision:

- **Ledgerix Pro LLC's own books → QBO.** Self-billing of clients (the `POST /api/accounting/v1/invoices` endpoint per the API spec) creates invoices in Ledgerix Pro's own QBO. Monthly recurring revenue, setup fees, refunds, and all company expenses live here.
- **Xero → reserved for client books only.** Xero is one of the two supported client platforms (alongside QBO). Ledgerix Pro itself does NOT maintain its books in Xero.

**Rationale:** Separating the platforms makes operational and architectural reality match. One real company in QBO (Ledgerix Pro LLC), distinct client companies in Xero or QBO depending on each client's existing platform. This avoids ambiguity in queries, audit logs, and data isolation between "our books" and "client books."

**Implementation note:** This is enforced architecturally in the `POST /api/accounting/v1/invoices` endpoint, which rejects `platform=xero` and always operates against Ledgerix Pro's QBO connection.

**Historical note (May 16, 2026):** During Phase 4b smoke testing, a Xero trial organisation named "Ledgerix Pro LLC" was discovered in the local DB — an artifact of the initial Xero developer-account setup process. It was created when the founder set up Ledgerix Pro's Xero developer credentials and was never intentionally used for company books. It was disconnected and removed from both the Xero side (DELETE /connections) and the local `accounting_connections` table to align operational state with this architectural intent.

### Founder time commitment

- **Steady state (Stage 4-5, 45-50 clients):** 14 hours/week (2 hrs/day, 7 days/week) hard cap on operating the business
- **Growth phases (Stages 1-3):** up to 21 hours/week (3 hrs/day) of operational time when engineering investment or Scale-Up sales push requires it
- **Sales activity:** uncapped during growth phases; trends toward delegated/inbound by Stage 4-5
- **Engineering investment:** founder will invest engineering hours as needed at each stage transition to upgrade tooling

### Engineering investment sequence

- **Phase 4 (current):** Accounting API endpoints — unbreaks the 10 BROKEN agents identified in Phase 3b audit
- **Phase 5 (next):** HITL review tooling — reduces founder/operator time per client/day from current ~10 minutes to mature ~3 minutes; enables sustained solo operation through ~25 clients
- **Phase 5b:** Categorization Rule Service — AI analyzes historical BankTransactions to recommend Bank Rules for human application in Xero UI
- **Phase 6:** Operator handoff UX — enables contractors (US and offshore) to operate without founder supervision; role-based access, audit trails, quality consistency
- **Phase 6b:** Long-term data retention infrastructure — 7-year archival storage, encryption-at-rest, legal hold mechanism
- **Phase 7:** Knowledge compounding — operator decisions feed back into AI suggestions; cross-operator quality consistency becomes automatic

The architectural decisions in supporting technical documents filter through one question: does this serve the 50-client lifestyle business at ~$285k/year? Decisions that don't are out of scope.

### Cancellation policy

- **Notice period:** 30 days written notice required, delivered via email to a designated cancellation address (to be established as part of Phase 4 ops setup)
- **Service during notice period:** Service continues normally; final reconciliation completed through cancellation date
- **Standard off-boarding (all tiers):** Final reconciliation, final month-end financials, written recommendations for the client's next bookkeeper
- **Premium off-boarding (Scale-Up tier):** Standard off-boarding plus a 30-minute briefing call with the client's next bookkeeper

### Data retention policy

Ledgerix Pro retains all client operational data for 7 years after cancellation. The 7-year clock starts at the cancellation effective date. Retention rationale is litigation defense — accounting service providers face potential disputes years after an engagement ends, particularly following IRS audits of former clients. Without records of what Ledgerix Pro actually did during the engagement, defense against claims becomes difficult or impossible.

**Retained data includes:**
- GHL contact records and all client communications
- Agent run history (which agent did what, when, with what confidence)
- HITL approvals (which human reviewed and approved each decision)
- Audit logs (compliance with stated SOPs)
- Internal categorization decisions and reasoning
- System events related to the client

**Retention mechanics:**
- Production systems may purge older records for performance — this is acceptable
- Long-term backup storage (encrypted at rest) preserves the full 7-year window
- After 7 years, archived data is securely destroyed
- **Legal hold mechanism:** Any data subject to active legal hold (subpoena, ongoing dispute, IRS audit notification involving the former client) is retained until the hold is lifted, regardless of the 7-year clock

**What Ledgerix Pro does NOT hold:**
- The client's actual accounting records (these live in the client's own QBO/Xero throughout the engagement and remain there after cancellation)
- The client's 7-year tax retention obligation falls on them, not on Ledgerix Pro

### Refund policy

**Monthly subscription fees:**
- **First 30 days satisfaction guarantee:** New clients may cancel within 30 days of service start for any reason and receive 100% refund of monthly fees paid
- **After first 30 days:** Monthly fees are non-refundable. Cancellation stops future billing but does not refund past months

**Setup/migration fees:**
- Always non-refundable. Setup work represents completed labor and is not refunded under any standard circumstance.

**Service failure exception:**
- In cases of documented Ledgerix Pro service failures (e.g., material miscategorization causing tax filing issues, system errors causing client harm), the founder may issue partial or full refunds at discretion. This exception covers genuine service quality failures, not dissatisfaction with the service overall.

### Chart of Accounts standardization

All Ledgerix Pro clients use a standardized industry-specific Chart of Accounts. Templates are maintained by Ledgerix Pro and applied during onboarding:

- Trades-HVAC, Trades-Plumbing, Trades-Electrical, Trades-Roofing, Trades-Landscaping (job-costing focused)
- Agency-Marketing, Agency-Creative, Agency-Consulting (project profitability focused)
- Law-Firm (trust account compliance focused)
- Small-Business-Generic (catch-all for retail, professional services, etc.)

Clients with existing books in non-standard COAs are migrated to the standard during onboarding (the migration setup fee covers this work). This standardization is fundamental to AI categorization consistency, cross-client rule transfer, and operator productivity.

Maintenance of these templates is part of the Knowledge Base Manager agent's responsibilities at scale. Initial template library design is a focused project to be completed before Phase 5 (Categorization Rule Service) begins, with industry expert validation via a one-time consulting engagement.

### Browser surfaces

Ledgerix Pro maintains multiple browser-based surfaces that serve different audiences. These exist outside the accounting API specified in Phase 4 but are tracked as part of overall platform architecture.

**Existing surfaces (today):**

| Surface | URL | Audience | Auth model | Purpose |
|---|---|---|---|---|
| Internal Dashboard | `api.ledgerixpro.com/dashboard` | Founder, operators | Dashboard secret header | Operational visibility, agent oversight, debugging |
| Client Portal | `api.ledgerixpro.com/portal/{slug}` | Each Ledgerix Pro client | Slug-based redirect (no real auth in v1) | Client-facing view of agent activity, issues, and reports |
| Public Diagnostic | `api.ledgerixpro.com/diagnostic` | Prospects (lead magnet) | Public access | CRO-driven Story Selling tool for prospect qualification |

**Future surfaces (planned):**

| Surface | Phase | Audience | Purpose |
|---|---|---|---|
| HITL Review UI | Phase 5 | Founder + operators | Approve/reject agent categorization decisions; the central productivity surface for Stage 2-4 |
| Operator Handoff UX | Phase 6 | Operators (US + offshore) | Role-based access, audit trail browsing, quality consistency tooling |
| Knowledge Compounding UI | Phase 7 | Founder + operators | Review and refine the institutional knowledge that feeds AI suggestions |

**Cross-cutting browser concerns:**

- **Cross-browser testing:** Chrome (primary), Safari (Mac users), Firefox (operators), Edge (corporate clients). Mobile Safari and Chrome for client portal access from phones. No formal testing matrix today; introduced as part of Phase 5 build.
- **Mobile responsiveness:** Client portal especially needs to work well on phones — clients will check their status during the workday from mobile. Internal dashboard remains desktop-first.
- **Accessibility:** Not addressed in v1. Revisited if a client requests it or if regulatory requirements emerge.
- **Client portal authentication:** Currently uses slug-based redirects with no real authentication. Acceptable for beta phase (one client, Enyrgy) but inadequate before the first paying client. Hardening planned as part of Phase 5 work.
- **Dashboard secret rotation:** The dashboard uses a shared secret header. Rotation procedure exists but is undocumented. To be formalized when Phase 5 introduces multi-operator access.

Browser surface engineering investment is distributed across Phases 5-7. Not a separate phase; the dashboards and portals get capability extensions as the agent system matures. No browser work is part of Phase 4 itself (API endpoints only).

### Email infrastructure

Ledgerix Pro uses GoHighLevel (GHL) for email delivery across agent communications. The choice of LC Email (GHL's native infrastructure) versus Custom SMTP has architectural implications worth being explicit about.

**Current state (v1):**

All agent emails (Reporter, AP Specialist, Tax Liaison, Senior Bookkeeper, QC, Reactivation, Referral & Reviews, SDR Laura) are sent through GHL's LC Email. This is the default and works well for the lifestyle business at 50-client scale.

**What GHL LC Email handles automatically:**

- **Bounce suppression:** Hard bounces are automatically suppressed at the GHL level — once an address hard-bounces, GHL won't send to it again. This is critical hygiene done for us.
- **Bounce-rate monitoring:** GHL temporarily suspends email sending for accounts exceeding ~5% bounce rate. After 3 such suspensions in 7 days, sending is permanently blocked until email verification is enabled.
- **ESP block detection:** GHL detects when Gmail/Yahoo/Outlook block emails due to spam rates exceeding 1%. Triggers 24-hour temporary restrictions. Resets after 7 consecutive days of clean sending.
- **Deliverability health monitor:** GHL alerts when bounce rate exceeds 2% (introduced in 2026).
- **Authentication (SPF, DKIM, DMARC):** Configured at the dedicated-domain level. Ledgerix Pro's sending domain configuration must be verified.

**What GHL does NOT handle (Ledgerix Pro must address):**

- **Sender reputation building:** New domains require 2-4 week warm-up before high-volume sending. Ledgerix Pro's `ledgerixpro.com` domain is past this phase; new sub-domains for sending would need warmup.
- **Throttling:** GHL has no built-in throttling — campaigns dump the entire queue at once. Not an issue at lifestyle scale (low agent email volume).
- **List hygiene at the source:** Ledgerix Pro must ensure agents never email invalid addresses. Currently handled by: clients imported via GHL contact creation (validated at entry); agent emails go to known-good addresses from the contact record.
- **Tracking past "Sent":** With Custom SMTP, GHL only shows opens and clicks. LC Email shows full delivery status. Since Ledgerix Pro is on LC Email, this is a non-issue today.

**Monitoring tools to establish:**

- **Google Postmaster Tools** (postmaster.google.com) — monitors sender reputation specifically with Gmail. Free, requires DNS verification of the sending domain.
- **MXToolbox** (mxtoolbox.com) — verifies DKIM, SPF, DMARC configuration. Checks blacklist status. Free for basic checks.
- **GHL Email Reporting** — built-in. Bounce rate, open rate, deliverability health alerts.

**LC Email vs Custom SMTP decision:**

Ledgerix Pro stays on **LC Email** for v1. Rationale: GHL handles bounce suppression, ESP detection, and deliverability monitoring out of the box, which matches the lifestyle business operating constraints. Custom SMTP gives more control and dedicated reputation but requires founder time on infrastructure management that doesn't generate client value.

**Revisit Custom SMTP if:**
- Email volume grows beyond ~5,000 emails/month and shared-IP reputation becomes a constraint
- Deliverability problems emerge that LC Email can't resolve
- Compliance requirements emerge that demand owned-infrastructure email handling

For 50 clients sending ~10-30 agent emails per client per month (~500-1,500 total/month), LC Email's shared-pool reputation is fine.

### Other infrastructure (cataloged, not specified)

The following infrastructure categories are real and will require attention as Ledgerix Pro matures. They are not deep-specified in this Strategic Plan; they are cataloged here as known concerns to be addressed when the appropriate phase or trigger arrives.

#### Billing infrastructure (Stripe)

**Current state:** Ledgerix Pro uses Stripe for payment processing. Setup tested with Enyrgy (test mode) but no real client billing has occurred yet.

**In scope before first paying client:**
- Stripe live-mode activation and verification
- Tax handling for AZ-based customers (sales tax obligations on SaaS services — Arizona does NOT tax SaaS as of current law, but should be confirmed with an accountant)
- Invoice generation flow tied to GHL contact records
- Subscription lifecycle handling (creation, renewal, failure, cancellation)
- Setup fee collection at onboarding
- Dunning (failed payment recovery) workflow
- Refund processing for the 30-day satisfaction guarantee

**Deferred to scale:**
- Multi-currency support (US-only target)
- Stripe Tax integration for automated tax handling
- Custom invoice templates and branding
- Annual prepay support (currently out of scope)

#### Compliance infrastructure

**Current state:** Ledgerix Pro is a sole-proprietor LLC in Arizona providing AI-assisted bookkeeping services. No professional licensing required at this scale.

**Known compliance considerations:**

- **Data residency:** All Ledgerix Pro data hosted in US data centers (Railway, GHL infrastructure). No EU/GDPR exposure since all clients are US-based.
- **PII handling:** Client business names, contact emails, and business operational data are stored. No SSNs, no consumer PII, no payment card data (Stripe holds card data). Reasonable security: encrypted-at-rest via Postgres + Railway, encrypted-in-transit via TLS.
- **Accounting industry regulations:** Bookkeeping is largely unregulated at the federal level. State regulations vary; AZ does not regulate bookkeepers. Tax preparation IS regulated (PTIN required) — Ledgerix Pro DOES NOT perform tax preparation, only tax-relevant bookkeeping.
- **Data breach notification:** AZ has data breach notification requirements. Incident response plan should exist before first paying client.
- **Client agreement and Terms of Service:** Currently no formal client agreement document exists. Needed before first paying client.

**Deferred to scale or specific triggers:**
- SOC 2 audit (not justified at 50 clients)
- HIPAA compliance (not in scope)
- State CPA board notifications (not relevant)

#### Customer support infrastructure

**Current state:** No formal customer support infrastructure. Beta client (Enyrgy) is the founder.

**In scope before first paying client:**
- Designated support email address (`support@ledgerixpro.com`)
- SLA commitment in client agreement (response time)
- Ticketing/tracking via GHL conversation threads tagged appropriately
- Escalation path for technical issues vs. accounting questions

**SLA targets (proposed for client agreement):**
- Standard inquiries: 24 business hours response
- Service issues (categorization disputes, billing problems): 12 business hours
- Critical issues (agent producing wrong output, system errors affecting books): 4 business hours
- "Business hours" defined as 9am-5pm Mountain Time, Monday-Friday

**Deferred to scale:**
- Help desk software (not justified at small scale)
- Knowledge base / self-service docs
- Phone support (email-first indefinitely)
- Multi-tier support staff

---

## Cross-References

- Phase 4 technical specification: `PHASE-4-ACCOUNTING-API-SPEC.md`
- Pre-launch operational checklist: see `PHASE-4-ACCOUNTING-API-SPEC.md` Section 4.3
- Repository recovery procedures: `RESET.md` in repository root
- Per-agent operational instructions: `agents/{name}/AGENTS.md` files

---

**END OF STRATEGIC PLAN**
