# ADR-003: Phase 4c — Write-Endpoint Safety Architecture

**Status:** Accepted
**Date:** May 24, 2026
**Decision Maker:** Scott Hansbury (Founder)
**Supersedes:** None
**Related:** ADR-002 (Write endpoint design), commit 91a554f4 (deferral of transaction category endpoint), `docs/PHASE-4-ACCOUNTING-API-SPEC.md`

## Context

ADR-002 established the route handler pattern for Phase 4b write endpoints. Sunday's first attempt at implementing one of those endpoints (POST /transactions/:txnId/category) shipped with partial spec compliance (`previousAccountRef: null` returned because per-platform get-transaction-by-id functions don't exist). On reflection, this violated a foundational trust tenet for Ledgerix Pro:

**No real clients (beta or paying) will be onboarded until the system is correct, trustworthy, and dialed in for security and safety of client funds.**

Applying this tenet uniformly — including to Ledgerix Pro's own books (Ledgerix Pro is itself a client of its own system) — means partial-spec write endpoints with documented gaps cannot ship. The endpoint was reverted (commit 91a554f4) and all three Phase 4b write endpoints were deferred.

The pattern that keeps producing tenet violations is: write endpoints lack a safety layer. Each endpoint's specific concerns (amount caps, dedupe ambiguity, pricing validation) can't be solved per-endpoint without inconsistency. They need a foundational architecture every write endpoint sits atop.

Discovery during the design phase: the codebase already has a substantial approval system (`approvals` table, `approvalService` with create/approve/reject/comment/revision methods, `approval_comments` table, type-discriminated dispatch in `approve()`). The existing `hire_agent` approval type demonstrates the pattern: agents request an approval, humans decide, downstream effects execute on approval. The safety architecture extends this same pattern rather than building parallel HITL infrastructure.

## Decision

Build Phase 4c — a safety architecture layered beneath write endpoints — comprising five distinct pieces. Reusable across all current and future write endpoints. Built before any write endpoint ships.

### The Five Pieces

**Piece 1: Pricing & rate cards source of truth**
A canonical source for service tier pricing (Foundation/Growth Engine/Scale-Up, Charter vs Standard) plus per-client overrides. Used by POST /invoices to validate `lineItems.sum` against expected price.

**Piece 2: Customer identity & dedupe (with HITL escalation)**
Refactor of `findOrCreateCustomer` to return explicit dedupe decisions rather than silent matches. Ambiguous matches (e.g., name match without email match) trigger approval requests rather than auto-creating duplicates.

**Piece 3: Write threshold & cap framework**
Per-endpoint, per-client configurable thresholds. Writes that exceed thresholds trigger approval requests instead of executing.

**Piece 4: Approval system integration (using existing `approvalService`)**
New approval types in the existing `approvals` table. New write-approval dispatcher executes deferred writes when approvals resolve.

**Piece 5: Read verification token (for payments)**
A short-lived token issued by GET /invoices that POST /payments requires. Forces the agent to read fresh invoice state before applying a payment. Lower priority — may be deferred to Phase 5 if Pieces 1-4 deliver sufficient safety.

## Design Decisions

The 10 design questions identified during planning, with proposed resolutions and rationale.

### Q1. Approval type naming convention

**Decision:** Dot-namespaced (`accounting.payment.threshold_exceeded`).

**Rationale:** The existing `hire_agent` type is flat, but our activity-log action values already use dot-namespacing (`accounting.transactions.update_category`). Approval types are conceptually parallel to activity-log actions — they describe an event in the system. Consistency across the audit + approval surface beats consistency with the single legacy `hire_agent` type.

The cost is one inconsistency (`hire_agent` vs the new dot-namespaced types). Acceptable for now. If it becomes painful, `hire_agent` can be renamed in a separate refactor — its current callers are few.

### Q2. Payload schemas per type

**Decision:** Each approval type defines a typed payload schema. Payload must contain everything needed to execute the deferred write when approved — the original request body, query params, and any state captured at approval-time.

**Schemas:**

For `accounting.payment.threshold_exceeded`:
```typescript
{
  requestType: "POST /api/accounting/v1/payments",
  companyId: string,
  contactId: string,
  invoiceId: string,
  amount: number,
  paymentDate?: string,
  entityRef?: string,
  reason?: string,
  idempotencyKey?: string,
  thresholdAmount: number,         // what threshold was exceeded
  expectedRange?: { min: number, max: number },  // for invoice-balance comparison
}
```

For `accounting.invoice.dedupe_ambiguous`:
```typescript
{
  requestType: "POST /api/accounting/v1/invoices",
  companyId: string,
  contactId: string,
  customerName: string,
  customerEmail: string,
  serviceTier: "Foundation" | "Growth Engine" | "Scale-Up",
  billingPeriod: { start: string, end: string },
  lineItems: Array<{ description: string, amount: number }>,
  dueDate?: string,
  reason?: string,
  idempotencyKey?: string,
  dedupeDecision: {
    matchedCustomerId: string,
    matchType: "name_only" | "email_only_different_name",
    confidence: number,
  },
}
```

For `accounting.invoice.pricing_mismatch`:
```typescript
{
  requestType: "POST /api/accounting/v1/invoices",
  // ...same as dedupe_ambiguous payload, minus dedupeDecision...
  pricingDecision: {
    sentAmount: number,
    expectedAmount: number,
    serviceTier: string,
    isCharter: boolean,
    delta: number,
    deltaPercent: number,
  },
}
```

For `accounting.transaction.category_with_unknown_previous`:
```typescript
{
  requestType: "POST /api/accounting/v1/transactions/:txnId/category",
  companyId: string,
  contactId: string,
  txnId: string,
  newAccountRef: string,
  reason?: string,
  idempotencyKey?: string,
  unknownPreviousReason: "platform_lookup_unavailable" | "transaction_type_unknown",
}
```

**Rationale:** Payloads must be self-sufficient because approvals may sit pending for hours/days. The request that arrived must be re-executable from the payload alone. Schemas are documented in the `services/accounting/write-approvals.ts` module as TypeScript types.

### Q3. Dispatcher integration pattern

**Decision:** Extend the existing `approvalService.approve()` switch directly. Add a new `services/accounting/write-approvals.ts` module that exports a single function `executeApprovedAccountingWrite(db, approval)`. The `approve()` method gets a new case branch (`if type starts with "accounting."`) that calls this function.

**Rationale:** Adding to the existing switch is mechanical. It matches how `hire_agent` is wired today. The registry pattern (handlers register themselves by type) is architecturally cleaner but is a separate refactor with cross-cutting changes. Doing it now blends concerns.

Future Phase 5 work can move the dispatch to a registry. Until then, the switch grows by one branch for accounting types.

### Q4. HTTP response when approval is required

**Decision:** `202 Accepted` with body:
```json
{
  "data": {
    "status": "pending_approval",
    "approvalId": "uuid",
    "approvalType": "accounting.payment.threshold_exceeded",
    "reason": "Amount $15000 exceeds threshold $10000 for this client"
  },
  "meta": {
    "performedAt": "ISO 8601 timestamp",
    "auditLogId": "uuid"
  }
}
```

**Rationale:** `202 Accepted` is semantically correct — the request was received and is being processed, but the response isn't ready yet. Standard HTTP semantic for async/queued operations.

Alternatives rejected:
- `409 Conflict` — implies the request is malformed; not the case here
- `200 OK` with deferred shape — confuses callers expecting `200` to mean "done"
- `403 Forbidden` — implies a permanent denial; this is conditional

Auditable property: every approval-required response writes an `activity_log` entry with `status="success"` and `details.approval_required: true`. This is success in the sense that the system handled the request correctly — it routed it for human review.

### Q5. Idempotency interaction

**Decision:** When a write triggers an approval (instead of executing immediately):
- Idempotency key IS stored in `idempotency_keys` with the 202 response cached
- A subsequent request with the same idempotency key returns the 202 (replay) with `meta.idempotencyReplay: true`
- The approval ID in the cached response is the same approval the original request created
- When the approval is later resolved (approved or rejected), the deferred write executes if approved
- The deferred write does NOT create a new idempotency_keys row — it uses the existing one

If the approval has already been resolved when a duplicate idempotency-key request arrives:
- The 202 is still returned (idempotent replay)
- BUT the approval ID in the response now references a resolved approval
- Caller can use GET /api/approvals/:id to check current status

**Rationale:** Idempotency keys are about request identity, not response state. A duplicate request returns the same response it returned the first time, regardless of whether the underlying approval has been resolved since.

This is the simplest model. The alternative ("show current status of the approval in the replay") is technically more useful but introduces a mutable replay shape that complicates the idempotency contract.

### Q6. Pricing source of truth

**Decision:** New DB table `service_tier_pricing`:

```typescript
{
  id: uuid,
  tier: "Foundation" | "Growth Engine" | "Scale-Up",
  isCharter: boolean,
  monthlyAmountCents: number,       // 19900 for $199.00
  currency: "USD",
  effectiveFrom: timestamp,
  effectiveTo: timestamp | null,    // null = current
  createdAt: timestamp,
}
```

Plus per-client override table `client_pricing_overrides`:
```typescript
{
  id: uuid,
  ghlContactId: string,             // GHL contact ID
  tier: "Foundation" | "Growth Engine" | "Scale-Up",
  monthlyAmountCents: number,
  reason: string,                   // why this override exists
  effectiveFrom: timestamp,
  effectiveTo: timestamp | null,
  approvedByUserId: string,         // who approved this override
  approvedAt: timestamp,
  createdAt: timestamp,
}
```

New service function `getExpectedPriceCents(db, tier, contactId?)`:
- If `contactId` has an active override, use that
- Otherwise, look up the tier's current price (`effectiveTo IS NULL`) and `isCharter` flag for that contact (charter rate if among the first 10 clients)
- Returns `{ amountCents, source: "override" | "tier_charter" | "tier_standard", priceRecordId: string }`

**Rationale rejected (TypeScript constants):** Constants in a file are simpler to maintain but suffer two problems: (1) pricing changes require code deploys, (2) per-client overrides have no clean representation without a database.

**Rationale rejected (GHL custom fields only):** GHL is the source of truth for which TIER a client is on, but not the canonical PRICE per tier. Storing the price in GHL means propagating it across all contact records when prices change — error-prone. The tier is in GHL; the price for the tier is in our DB.

**Bootstrap data:** Seed step (deferred to Phase 4c.1b runbook — see below) writes the six canonical pricing rows from EA Section 7 (Foundation Charter $199, Foundation Standard $299, Growth Engine Charter $399, Growth Engine Standard $599, Scale-Up Charter $999, Scale-Up Standard $1,299) into `service_tier_pricing`. **Note:** Earlier draft of this ADR referenced stale pricing values ($499, $799, $899) which predated the May 17, 2026 EA v3.2 repricing. Corrected per the Amendments section below.

### Q7. Customer dedupe logic

**Decision:** Refactor `findOrCreateCustomer` to return `{ customerId, action }` where `action` is one of:

- `"found_by_email"` — exact email match (highest confidence; auto-proceed)
- `"found_by_name_exact"` — exact name match, no email or email matches (high confidence; auto-proceed)
- `"created_new"` — no match found, customer created (auto-proceed)
- `"ambiguous_name_only"` — name match but provided email differs from stored email (REQUIRES APPROVAL; do not auto-proceed)
- `"ambiguous_email_match_different_name"` — email match but name differs significantly (REQUIRES APPROVAL; do not auto-proceed)

The function returns the action; the calling code decides whether to proceed or request approval.

For "differs significantly" on names: Levenshtein distance > 3 OR normalized-name (lowercased, whitespace trimmed) inequality. Punctuation differences (e.g., "Acme, Inc." vs "Acme Inc") do not trigger ambiguity.

**Rationale:** The spec's current behavior is "name-only match creates a new customer (may result in duplicates)." This is exactly the kind of silent gap that violates the tenet. Making it explicit — either confident match or HITL escalation — eliminates the silent duplicate path.

The Levenshtein threshold of 3 is a guess; tuneable. Reviewers can comment on rejected approvals saying "use lower threshold" and we adjust.

### Q8. Threshold definitions — per-client or global

**Decision:** Both. Hierarchy:

1. Per-client per-endpoint threshold (most specific)
2. Per-endpoint global default

New DB table `write_thresholds`:
```typescript
{
  id: uuid,
  ghlContactId: string | null,      // null = global default
  endpoint: string,                  // "accounting.payments" / "accounting.invoices" / "accounting.transactions.category"
  field: string,                     // "amount" / "lineItems.sum" / etc.
  comparator: "gt" | "gte",
  thresholdValue: number,            // in cents for monetary
  action: "require_approval",        // future: "deny", "warn"
  reason: string,                    // human-readable description
  effectiveFrom: timestamp,
  effectiveTo: timestamp | null,
  createdAt: timestamp,
}
```

New service function `getApplicableThresholds(db, endpoint, contactId)`:
- Query for thresholds matching `(endpoint, contactId)` OR `(endpoint, NULL)`
- Per-client thresholds override global thresholds for the same `field`
- Returns array of active threshold records

Bootstrap data (from EA Section 6.3):
- Global threshold: `accounting.payments` / `amount` / `gt` / 1000000 (= $10,000) — "Payroll runs >$10,000 — CFO must sign off"
- Global threshold: `accounting.invoices` / `lineItems.sum` / `gt` / 100000 (= $1,000) — "Unusual invoice amount"

**Rationale:** Per-client thresholds are needed because a $10,000 payment is normal for a Scale-Up agency client but anomalous for a Foundation freelancer client. Global defaults provide a floor for clients without specific configuration.

The "deny" and "warn" actions in the schema are foreshadowing — for now only `require_approval` is implemented. Future expansion paths preserved.

### Q9. Recovering deferred write endpoint code

**Decision:** Do NOT restore from `docs/deferred/`. Rewrite against the new safety layer.

**Rationale:** The deferred files contain:
- Route handler with hardcoded `previousAccountRef: null` (the tenet-violating part)
- Tests that assert the partial-spec response shape
- Helper functions still useful (`requirePathParam`, `requireBodyString`, `optionalBodyString`)

The route + tests need genuine rewrites against the new safety architecture (call `getApplicableThresholds`, `getExpectedPrice`, etc.). Starting from `docs/deferred/` would carry the tenet-violation DNA forward.

The helpers (`requirePathParam` etc.) are tenet-neutral utilities; restore those when we re-ship write endpoints.

`docs/deferred/` files stay in place as reference. They're not deleted — future review (forensic, or new contributor onboarding) might benefit from seeing the rejected design.

### Q10. Read verification (Piece 5) timeline

**Decision:** Defer to Phase 5. Not in Phase 4c scope.

**Rationale:** The pieces 1-4 deliver real safety boundaries (threshold caps + dedupe + pricing validation + HITL queue). These prevent the most concerning failure modes (wrong amount, duplicate customer, wrong pricing) without requiring the agent to do a verification dance.

Read verification (a write requires fresh GET of related state) adds protocol complexity that may be unnecessary if pieces 1-4 cover the high-value cases. Better to ship 1-4, observe agent behavior in beta, and add read verification only if observed failures demand it.

If beta shows agents skipping the verify-after-write step yesterday's discussion described, Phase 5 adds the token-based read verification. Otherwise, the agent-instruction approach (documented in each agent's AGENTS.md) suffices.

## Implementation Plan

Suggested build order. Each piece is independently testable.

### Phase 4c.1: Pricing source of truth (Piece 1)
- DB migration: `service_tier_pricing` + `client_pricing_overrides` tables
- Seed migration: 6 canonical pricing rows
- Service function: `getExpectedPriceCents(db, tier, contactId?)` with tests
- No endpoint changes yet

### Phase 4c.2: Threshold framework (Piece 3)
- DB migration: `write_thresholds` table
- Seed migration: 2 global thresholds from EA Section 6.3
- Service function: `getApplicableThresholds(db, endpoint, contactId)` with tests
- No endpoint changes yet

### Phase 4c.3: Customer dedupe refactor (Piece 2)
- Refactor `qbo.findOrCreateCustomer` to return `{customerId, action}` shape
- Tests for each `action` branch
- No endpoint changes yet — just the service refactor

### Phase 4c.4: Write-approval dispatcher (Piece 4)
- New module `services/accounting/write-approvals.ts` with `executeApprovedAccountingWrite()`
- New approval types defined as constants
- Payload schemas as TypeScript types
- Extend `approvalService.approve()` to call the new dispatcher for accounting types
- Tests for the dispatcher (mock the actual write functions; verify dispatch routing)
- No endpoint changes yet

### Phase 4c.5: Re-ship the 3 write endpoints atop the safety layer
- POST /transactions/:txnId/category (with proper before/after capture or HITL fallback)
- POST /payments (with threshold check + pricing context)
- POST /invoices (with pricing validation + dedupe approval flow)
- Comprehensive tests including the approval-required paths
- Updates to PHASE-4-ACCOUNTING-API-SPEC.md to reflect the safety layer

## Open Items

- Approval dashboard UI for human reviewers — separate Phase 5 work
- Per-client threshold management UI — Phase 5
- Pricing override management UI — Phase 5
- Approval expiration/SLA (e.g., approvals pending > 7 days auto-escalate or auto-reject) — Phase 5
- Migration of legacy `hire_agent` to dot-namespaced naming — deferred refactor

## Amendments

### Amendment 1 (May 24, 2026): Architectural gaps surfaced during EA v3.3 / Brief v1.3 re-read

After committing Phase 4c.1 (commit `104e82fb`), a full re-read of the authoritative EA v3.3 and Brief v1.3 documents surfaced architectural gaps in this ADR that need explicit acknowledgment. These don't invalidate the Phase 4c.1 work shipped today, but they must be addressed before Phase 4c.5 (the actual write endpoints) can ship.

**Gap 1: Charter status has no defined storage in the documented architecture.**

The `getExpectedPriceCents(db, tier, isCharter, contactId?)` service function (shipped Phase 4c.1, commit `104e82fb`) requires `isCharter` as a parameter. But EA v3.3 documents the Charter Pricing Window in Section 7.1 as a persistent client-level status — Charter benefit follows the client across tier upgrades AND downgrades for as long as service is continuous, and is permanently lost on cancellation. No GHL custom field, DB schema, or other storage is documented for this property.

This is a tenet-relevant gap: the current architecture can't reliably determine `isCharter` for a caller. Three options need evaluation in a future focused session:

- Option A: Add a new GHL custom field (`is_charter`) per contact. Tier assignment writes it on onboarding. Easy but introduces GHL as runtime dependency for invoicing.
- Option B: Add a `client_charter_status` table to the local DB. Captures grant date, current status (active / cancelled-was-charter / never-charter), and history. Cleanest separation but requires a new schema + sync logic.
- Option C: Compute `isCharter` from a system-wide charter cutoff timestamp + client created_at. Treats charter as derived state. Simplest but doesn't model the "cancelled-and-returned forfeits charter" rule cleanly.

Decision deferred to Phase 4c.5 design discussion (when the actual invoice endpoint surfaces the need to populate `isCharter`).

**Gap 2: Setup fees are not modeled by Phase 4c.1's pricing schema.**

EA v3.3 Section 7 documents one-time setup fees ($249 Foundation / $349 Growth Engine / $1,200 Scale-Up). These are billed once at client onboarding, non-refundable except via the 30-day satisfaction guarantee. Phase 4c.1's `service_tier_pricing` schema only models monthly recurring pricing — there's no row type for one-time fees.

Three real options to address in a future focused session:

- Option A: Extend `service_tier_pricing` with a `pricing_type` column (`monthly_recurring` vs `setup_fee`). Same table, two row types per tier. Caller filters by type.
- Option B: Add a parallel `setup_fee_pricing` table with the same structure but a different lookup function. Cleaner separation but more schemas to maintain.
- Option C: Treat setup fees as a separate concern entirely — different invoice endpoint, different audit type, different approval rules. Maximum separation.

Decision deferred to Phase 4c.5 (when the invoice endpoint surfaces this need).

**Gap 3: Tier Qualifier matrix is not codified anywhere in the system.**

EA v3.3 Section 7.1 documents a structured Tier Qualifier matrix (monthly transaction volume, bank accounts, employees, integrations, annual revenue, job costing, trust/multi-entity, industry flags) that determines tier assignment for a prospective client. The existing free-audit / Tier-Fit Audit endpoint touches this, but the qualifier evaluation logic is in agent prompts, not codified as data.

This is NOT a Phase 4c blocker (tier assignment happens at onboarding, before invoicing). But it's an architectural debt that should be tracked. Future work item: codify the qualifier matrix as data (DB table or config) so that the audit endpoint can evaluate qualifiers programmatically, reality checks (audit_industry vs qualifiers) can be enforced, and reassessment when a client grows or shrinks doesn't depend on agent judgment alone.

Not assigned to a Phase yet — to be addressed when the audit/onboarding pipeline gets focused attention.

### Amendment 2 (May 24, 2026): Pricing values throughout this ADR corrected

The initial draft of this ADR (committed `1fca9a11`) referenced stale pricing values for Growth Engine Standard ($499 — actual $599 per EA v3.2 May 17 update) and Scale-Up tiers ($799 / $899 — actual $999 / $1,299 per EA v3.2 May 17 update). These values predated the May 17, 2026 repricing in EA v3.2 and were carried forward in my session memory rather than verified against the authoritative document.

Corrected as of this amendment. The Q6 Bootstrap data note now references the correct pricing. Any earlier commit messages or Phase 4c.1b runbook notes that referenced the stale values are forensic-only and not actionable (git history is immutable; the canonical values are in EA v3.3 and the Q6 section above).

### Amendment 3 (May 24, 2026): EA v3.3 and Brief v1.3 documents not yet reflecting Phase 4b / 4c work

EA v3.3 and Brief v1.3 (both updated May 17, 2026) predate ADR-002 (Phase 4b write endpoint design), Phase 4b infrastructure (idempotency keys, activity-log status extension, both shipped Saturday May 23), and ADR-003 itself (Phase 4c safety architecture, today). The authoritative documents need updating to reflect this work before they can guide future sessions reliably.

Action item: Document update pass scheduled for after this ADR amendment commit. Both documents will be updated in Word directly (authoritative source) and re-committed as `.docx` files; Claude does not auto-generate markdown versions.

---

## Status

**Status:** Accepted (with Amendments 1, 2, 3 added May 24, 2026)
