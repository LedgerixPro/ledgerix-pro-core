# ADR-004: Phase 4c.5 — Write-Endpoint Implementation Decisions

**Status:** Accepted
**Date:** May 28, 2026
**Decision Maker:** Scott Hansbury (Founder)
**Supersedes:** ADR-003 §"Phase 4c.5: Re-ship the 3 write endpoints atop the safety layer" (planning-level description superseded by the as-shipped implementation captured here)
**Related:** ADR-001 (Pattern B Full), ADR-002 (Write endpoint design), ADR-003 (Phase 4c safety architecture), `docs/PHASE-4-PROGRESS.md` (chronological implementation log), `docs/LedgerixPro-Enterprise-Architecture.md` (architectural canon)

## Context

Phase 4c (ADR-003) established the write-endpoint safety architecture (approvals + pricing + dedupe + thresholds). Phase 4c.5's task per ADR-003's plan was to re-ship the three deferred Phase 4b write endpoints atop that safety layer:

- `POST /api/accounting/v1/transactions/:txnId/category`
- `POST /api/accounting/v1/payments`
- `POST /api/accounting/v1/invoices`

What actually got built during Phase 4c.5 (May 24–28, 2026) was substantially richer than ADR-003's three-bullet plan. It comprised:

- **Seven architectural Decisions** (1–7). Decisions 1–3 established the admin-endpoint surface used to bootstrap the safety layer's reference data. Decisions 4–7 covered the read-side dispatcher expansion and the three write-endpoint designs.
- **Three architectural Q-items resolved** (Q-charter, Q-setup-fee, Q-multi-line-journals).
- **Two explicit REVISED notes** locking the contract-revision-before-code pattern (Decision 2 REVISED for admin auth; Q-inv-3-β REVISED for invoice pricing-mismatch replay).
- **The lock-then-implement discipline** as the established Phase 4c.5 workflow — every Decision arc began with a doc-only design lock, then implementation Pieces against the locked contract, then closeout.

The implementation surfaced architectural questions ADR-003 hadn't anticipated (charter status storage, setup-fee pricing model, the QBO/Xero read-side type-expansion problem, the GHL-vs-books-key identifier seam, the dollars-vs-cents money convention, the per-item-rounding-before-summing requirement under zero-tolerance comparison) and resolved each in a locked decision the WIP doc captured.

ADR-004 is the canonical record of those implementation-time architectural decisions. It supersedes the planning-level Phase 4c.5 description in ADR-003 §"Phase 4c.5: Re-ship the 3 write endpoints atop the safety layer" — that section described the work as planned; ADR-004 describes the work as shipped.

The WIP doc that this ADR distills (`docs/wip/phase-4c-5-write-endpoints-and-admin-api.md`) was retired to `docs/wip/archived/` in Migration Step 2 (a separate commit). The chronological implementation diary lives in `docs/PHASE-4-PROGRESS.md` (Sessions 1–5).

## Naming convention note (collision avoidance with ADR-003)

ADR-003 uses Q1–Q10 numbering for its 10 foundational design questions. The Phase 4c.5 WIP doc developed a parallel Q-numbering scheme for its own implementation-time questions. To avoid ambiguous "Q1" cross-references, ADR-004 uses descriptive labels:

- WIP-doc Q1 (Charter status storage) → ADR-004 **Q-charter**
- WIP-doc Q2 (Setup-fee pricing model) → ADR-004 **Q-setup-fee**
- WIP-doc Q3 (get-transaction-by-id) → resolved during Decision 4; cross-referenced inside Decision 4, not a top-level item
- WIP-doc Q5 (Multi-line journal write semantics) → ADR-004 **Q-multi-line-journals**

There is no WIP-doc top-level Q4. The original Session-1 Q4 (admin endpoint authentication) was resolved as Decision 2 and removed from the pending list; the gap in the surviving numbering reflects this. The `Q-pay-4` label in Decision 6 is a sub-decision INSIDE Decision 6 (threshold check location), NOT a top-level Q-item; it is captured inside the Decision 6 subsection.

The `Q-pay-1` / `Q-pay-2` / `Q-pay-3` / `Q-pay-F-i` / `Q-pay-F-ii` sub-decisions inside Decision 6, and the `Q-inv-1` through `Q-inv-3-γ` sub-decisions inside Decision 7, retain their existing labels — they are already disambiguated by the `pay`/`inv` prefixes and appear in committed code comments.

## Decisions

### Decision 1: Admin endpoint pattern for safety-layer data management

**Decision.** Use admin HTTP endpoints (e.g., `POST /api/admin/pricing/seed`, `POST /api/admin/thresholds/seed`) for all safety-layer data management — pricing, thresholds, future per-client overrides. NOT one-time TypeScript scripts. Endpoints live in `server/src/routes/admin.ts` under the existing instance-admin auth, not in a parallel admin app or separate surface.

**Locked Session 1 (2026-05-24).** Shipped Session 2 (2026-05-25, commit `ff3875e8`): `POST /api/admin/pricing/seed` + `POST /api/admin/thresholds/seed` with bearer-token auth (Lock 1B pattern).

**Rationale.**

1. **Auditability is the load-bearing constraint.** The 7-year audit retention requirement (the system is being built for serious financial work) tips the decision decisively toward admin endpoints. Endpoints write to `activity_log` automatically; scripts log to stdout, which does not persist durably. Scripts cannot deliver durable audit trails.
2. **Scalability.** Irrelevant for one-time seed but admin endpoints become the foundation for ongoing data management (per-client pricing overrides, threshold adjustments, new tier additions).
3. **Security marginal cost is small.** HTTP endpoints add attack surface (which scripts don't) but the board-user auth boundary is already established. The marginal cost is small relative to the durable-audit benefit.
4. **Efficacy.** Admin endpoints are programmatically discoverable in the API surface, support idempotent re-runs (see Decision 3), and provide a permanent record of who-changed-what-when.

**Rejected.** One-time TypeScript scripts for seeding. Cons: no durable audit trail; not reusable for ongoing data management; would require a separate "run this once" muscle for every future ref-data change.

### Decision 2: Admin endpoint authentication — assertInstanceAdmin (REVISED)

**Decision (REVISED).** Admin endpoints authenticate via the existing `assertInstanceAdmin` function in `server/src/routes/authz.ts`. This natively supports three paths:

1. `source: "local_implicit"` — local dev mode (auto-grants instance admin)
2. `source: "session"` — board user logged in via better-auth session; `isInstanceAdmin` set if user has instance admin role in DB
3. `source: "board_key"` — board API key bearer token; `isInstanceAdmin` set if the key's underlying user has instance admin role

All three paths capture a specific user identity in the activity log (`actor_id` = the user's ID from the auth path).

**Original lock and revision.** Decision 2 was originally locked Session 1 (2026-05-24) as "session-only first, CI/CD bearer-token path committed for future" — based on an INCORRECT assumption that board API keys were unattributed credentials requiring a separate bespoke API-key surface. **REVISED later in the same session** after reading the actual auth middleware code: `server/src/middleware/auth.ts` lines 105–115 showed the board_key path captures `userId: boardKey.userId` — board API keys ARE tied to specific user identities. Therefore:

- The board_key path is what Decision 2 was calling "the CI/CD bearer-token path" (both are bearer-token auth with user-identity tracking).
- The existing `assertInstanceAdmin` correctly authorizes admin operations from both session AND board_key paths.
- Building a separate `assertInstanceAdminSessionOnly` would create an inconsistent abstraction fighting the existing one.

**Practical implications.**

- Scott calls admin endpoints via dashboard (session path) — most common.
- Scott also uses the board API key for curl/CLI calls (board_key path) — covered without additional infrastructure.
- Future CI/CD automation uses the board_key (or a dedicated admin user's API key) — no separate "CI/CD path" needs to be built.
- Audit log captures the specific user identity in both cases.

**Lesson preserved.** This decision was originally locked without first grepping the existing auth code. The "verify before assuming" discipline (Tenet #7) was violated. The revision happened the same session when scaffolding began and the code was actually inspected. Future sessions: read the relevant auth code BEFORE locking auth-related decisions.

**Decision 2 REVISED set the precedent for Q-inv-3-β REVISED in Decision 7 — locked decisions get explicit doc-first revisions, not silent drift. Two REVISED examples now exist in Phase 4c.5; both shipped in commits that updated the WIP doc BEFORE the code that diverged from earlier language.**

### Decision 3: Admin endpoint idempotency — Option D-modified, version-aware

**Decision.** Seed-style admin endpoints use **version-aware idempotency**. The endpoint compares submitted data against currently-active rows and routes each candidate row to one of three outcomes:

1. **Identical to active row** → SKIP. No DB write. Counted as `skipped`.
2. **Different from active row** → SUPERSEDE. Set existing row's `effective_to=now()`, INSERT new row with `effective_from=now()`. Counted as `superseded` + `newRows`.
3. **No active row for this key** → INSERT. New row with `effective_to=null`. Counted as `inserted`.

**Locked Session 1 (2026-05-24).** Implemented Session 2 (2026-05-25) via the `compareAndSeed<T>` helper at `server/src/services/admin/compare-and-seed.ts`.

**Response shape.**

```json
{ "data": { "inserted": N, "skipped": N, "superseded": N, "newRows": N } }
```

**"Identical" comparison rules.** Compare the business-meaningful fields (e.g., for `service_tier_pricing`: `tier`, `is_charter`, `monthly_amount_cents`, `currency`). Exclude metadata (`id`, `effective_from`, `effective_to`, `created_at`). Each schema that supports seeding defines its own "identity tuple" of fields.

**Rationale.**

1. **Accidental re-run is safe** (identical data → skip, no damage).
2. **Intentional change is supported** (different data → supersede with proper effective-dating).
3. **7-year audit retention is preserved AS DATA**, not just in `activity_log`. "What was the canonical Foundation Charter price on 2026-06-15?" is answerable by querying `service_tier_pricing` with effective-dating filters — no log archaeology required.
4. **Uses the effective-dating pattern already established** in `service_tier_pricing` and `client_pricing_overrides` (consistent system semantics).

**Downsides accepted.** More complex than `ON CONFLICT DO NOTHING`. "Identical" requires careful per-schema identity-tuple definition. The seed endpoint does comparison logic, making it smarter than typical seed scripts. More test surface (need to cover all three outcomes per row).

**Defect-1 note.** Production re-run on 2026-05-25 surfaced a SQL null-equality bug in the `compareAndSeed` helper — `eq(column, NULL)` never matches in SQL (not even `NULL = NULL`). When the identity tuple contained a null field (e.g., `write_thresholds.ghlContactId` for global thresholds), the helper failed to detect existing rows and created duplicates. Fixed Session 3 (commit `1727746a`) via `value === null ? isNull(col) : eq(col, value)`. Integration tests added against embedded Postgres to lock the fix.

### Decision 4: Transaction-lookup type expansion across QBO + Xero (Q-tx-by-id)

**Decision.** `getTransactionById` (the read-side dispatcher used by write endpoints to capture `previousAccountRef` for audit trails) covers all 11 planned transaction types across QBO and Xero. Per-platform write registry pattern: each type has a typed read handler (`fetchQboPurchase`, `fetchXeroBankTransaction`, etc.) registered in either `QBO_TYPE_REGISTRY` or `XERO_TYPE_REGISTRY`. Option A (full coverage) chosen over partial-coverage alternatives.

**Locked Session 3 (2026-05-26).** **FEATURE-COMPLETE Session 4 (2026-05-27).** Implementation arc:

- Phase 1 (commit `bffa3b16`): dispatcher + 3 of 11 types (QBO Purchase, QBO Bill, Xero BankTransaction).
- Phase 2 foundation (commit `635e4998`): `HttpResponseError` class + strict dispatcher discriminator (only 404 continues to next type; everything else rethrows).
- Phase 2 type expansion across 6 incremental commits: `8830f206` JournalEntry, `7027c79a` Deposit, `2195544a` BillPayment, `769a39ca` Payment, `bf96d2d3` Invoice (QBO half complete), `4e9d70be` Xero Invoice/Bill/ManualJournal (feature-complete).

**REVISED note (commit `fb13f98c`).** Mid-implementation discovery: Xero serves ACCREC (sales Invoice) and ACCPAY (purchase Bill) from the same `/Invoices/{id}` endpoint with a `Type` discriminator field. The original Decision 4 lock anticipated 4 separate Xero handlers; the REVISED note locks **3 handlers covering 4 type keys** (Invoice + Bill share `fetchXeroInvoiceOrBill`, registered under both keys). Final implementation: 11 type keys / 10 handler functions. Per Tenet #16, the revision shipped doc-first BEFORE the divergent code commit (`e7ee3273`).

**Resolves WIP-doc Q3** (get-transaction-by-id infrastructure scope). WIP-doc Q3 is now cross-referenced inside this Decision, not a top-level item.

**Test trajectory.** 161 → 198 (+37 tests across the Decision 4 arc).

### Decision 5: Write-side dispatcher and transaction-category update endpoint

**Decision.** Build `updateTransactionCategory` — the write-side counterpart to Decision 4's `getTransactionById`. Per-platform write registry pattern parallels the read side, but **covers fewer types**: 6 of the 11 read-supported types are writeable (QBO Purchase / Bill / Deposit + Xero BankTransaction / Invoice / Bill — the latter two share `updateXeroInvoiceOrBillAccount` per Decision 4's REVISED shared-handler pattern). The other 5 types throw `TransactionTypeNotCategorizableError`:

- **QBO BillPayment / Payment / Invoice**: top-level or Item-based account refs; not "category" semantics.
- **QBO JournalEntry + Xero ManualJournal**: multi-line Debit/Credit balance preservation needed; deferred to **Q-multi-line-journals** (later locked as deliberately excluded — see Q-items section below).

The asymmetry between read (11 types) and write (6 types) is by design and matches QBO/Xero API constraints — Tenet #14 (Trust Tenet) "no partial-spec compliance on safety-critical write endpoints."

**Locked Session 4 (2026-05-27).** **FEATURE-COMPLETE Session 4.** Implementation arc:

- Locked commit `07c056e5`, foundation `69505e90`.
- 5 per-type handlers: `d90d5304` / `034ac5c4` / `eb77d817` / `5f30c3b2` / `e7ee3273`.
- **Piece A** (commit `b7da7478`): final integration — extended `updateTransactionCategory` signature with optional `hintedType?: string` parameter (Tenet #16 compliant interface EXTENSION); DELETED legacy `qbo.updateTransactionAccount` + `xero.updateTransactionAccount` methods from `services/accounting/index.ts` (zero callers verified) plus 5 orphaned local interfaces (~85 lines removed). Single canonical write entry point established.
- **Piece B** (commit `001d547f`): approval-replay wiring for `TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS`. Replaced Phase 4c.4 stub in `executeApprovedAccountingWrite` with real execution. New `write_failed_replay` action enum value distinguishes "tried but underlying operation failed" from `stub_logged` and `write_executed`. Three outcomes: success / still-not-found / type-not-categorizable. Unknown errors propagate.
- **Piece C** (commit `bfc8549d`): POST `/api/accounting/v1/transactions/:txnId/category` route shipped end-to-end. URL+body validation; `assertCompanyAccess`; `withIdempotency` wrapping (ADR-003 Q5 compliance); three response paths (200 success / 202 approval / 400 not categorizable). FK safety fix caught pre-commit: separated `requestedByUserId` / `requestedByAgentId` per actor type to prevent agent IDs being written to a users-FK field in production. Agent-actor FK-separation test locks the pattern.

**Test trajectory.** 198 → 233 (+35 across Decision 5 + Pieces A/B/C).

### Decision 6: POST /payments — threshold-exceeded approval + entity-ref translation

**Decision.** `reconcilePayment` is the write-side dispatcher for payment-to-invoice reconciliation. Three primary sub-decisions locked at design time:

- **Q-pay-1 (Platform inference).** `reconcilePayment` infers platform from the `accountingConnections` lookup for `(companyId, contactId)` — matches Decision 4/5 dispatcher pattern. Callers drop the platform parameter.
- **Q-pay-2 (entityRef split).** Service signature splits the overloaded `entityRef` into typed `customerId?` + `accountId?` parameters; the locked Phase 4c.4 payload (`PaymentThresholdExceededPayload.entityRef`) is PRESERVED — single field, overloaded, per ADR-003 Q2 ("re-executable from the payload alone"). The Piece F helper `resolveEntityRefByPlatform` is the **single source of truth** for translation, used by BOTH the route handler and the approval-replay path.
- **Q-pay-3 (Audit-trail return).** Service returns `ReconcilePaymentResult` paralleling Decision 5's `UpdateTransactionCategoryResult` — captures platform-assigned `paymentId` previously discarded by `void` returns.

**Two implementation-time sub-decisions.**

- **Q-pay-F-i.** Both helpers (`resolveEntityRefByPlatform` + `evaluatePaymentThreshold`) live in a single new file `payments-helpers.ts`. Not split; not in `thresholds.ts`; not in `index.ts`.
- **Q-pay-F-ii.** v1 ships WITHOUT `expectedRange` in the `PaymentThresholdExceededPayload`. The optional field stays in the locked contract for future invoice-balance-comparison work but is not populated by v1.

**Q-pay-4 (threshold check location)** was settled by the existing `PaymentThresholdExceededPayload` shape — the payload includes `thresholdAmount`, so the code that populates it is the code doing the check. That code is the route handler (the only place that creates an approval row with this payload). Service stays threshold-unaware. No decision needed — the existing payload settled this. **`Q-pay-4` is a sub-decision INSIDE Decision 6, NOT a top-level Q-item.**

**Q-pay-5 (approval-replay path)** follows from Q-pay-1 — with platform inference, replay calls `reconcilePayment(db, payload.companyId, payload.contactId, payload.invoiceId, payload.amount, payload.entityRef, payload.paymentDate)` from the payload alone.

**Pre-implementation Tenet #7 verification surfaced 6 honest findings** that informed the lock: zero callers on legacy `reconcilePayment`, no threshold integration, no idempotency wiring, void return deviating from 17+ in-file conventions, overloaded entityRef parameter, established Decision 4/5 platform-inference pattern. The verified findings corrected an under-specified "2-3 hours" estimate into a properly-scoped 5-commit arc — **pattern worth keeping: verify BEFORE estimating, not after recommending.**

**Locked Session 4 (2026-05-27).** **FEATURE-COMPLETE Session 4.** Implementation arc:

- Lock commit `0924fb94`.
- **Piece D** (commit `37c55a08`): service refactor — `ReconcilePaymentResult` + `PaymentReferenceError` + split-ref + platform inference. **Required**, distinct from Decision 7's no-op Piece J.
- **Piece F** (commit `0d419021`): shared helpers — `resolveEntityRefByPlatform` + `evaluatePaymentThreshold` in `payments-helpers.ts`.
- **Piece E** (commit `46f60b53`): approval-replay wiring — `PAYMENT_THRESHOLD_EXCEEDED` stub replaced with real `reconcilePayment`.
- **Piece G** (commit `41376751`): POST `/api/accounting/v1/payments` route — FEATURE-COMPLETE.

**Test trajectory.** 281 → 308 (+27 across the Decision 6 arc).

### Decision 7: POST /invoices — dedupe + pricing gates

**Decision.** POST `/api/accounting/v1/invoices` creates monthly service invoices in **Ledgerix Pro's own QBO** (not client books) behind two safety gates per the Trust Tenet: dedupe (Q-inv-2) and pricing (Q-inv-3). The endpoint is used exclusively by the Billing & Invoicing agent.

**Three primary sub-decisions locked at design time.**

- **Q-inv-1 (billingMode discriminator).** Explicit `billingMode: "recurring" | "setup"` in the request body chooses the pricing function (recurring → `getExpectedPriceCents(tier, isCharter via isCharterForInvoicing(...))`; setup → `getSetupFeeCents(tier)`, no charter dimension per Q-setup-fee). **Q-inv-1-α**: the locked Phase 4c.4 approval payloads need no `billingMode` field because an approved row is a human override and replay re-creates rather than re-validates.
- **Q-inv-2 (Dedupe gate).** Route calls `qbo.findOrCreateCustomer` and reads its 5-value `action` discriminant. Two ambiguous actions (`ambiguous_name_only` / `ambiguous_email_match_different_name`) escalate to 202 with `accounting.invoice.dedupe_ambiguous`. **Q-inv-2-α**: fixed heuristic confidence values (0.5 for `email_only_different_name`, 0.3 for `name_only`) — honestly flagged as non-computed placeholders since `findOrCreateCustomer` does not compute a numeric score. **Q-inv-2-β**: replay uses stored `matchedCustomerId` (no re-resolve).
- **Q-inv-3 (Pricing gate).** Zero-tolerance comparison (**Q-inv-3-α**) of per-item-rounded line-item cents vs expected cents because Ledgerix Pro owns both sides of the number — no rounding/FX slack warranted. **Q-inv-3-γ**: helper `evaluateInvoicePricing` lives in new `invoices-helpers.ts`.

**Q-inv-3-β REVISED (commit `7ac02b90`, Tenet #16).** The `InvoicePricingMismatchPayload` carries `customerName` + `customerEmail` but NOT a resolved `customerId` (unlike `InvoiceDedupeAmbiguousPayload` which does). The locked Phase 4c.4 contract is not amended. Resolution: **Option A — pricing_mismatch replay re-resolves customer via `qbo.findOrCreateCustomer` before calling `createInvoice`.** Ambiguous-on-replay drift escalates to `write_failed_replay` (conservative path — the human's pricing approval does NOT authorize resolving a fresh dedupe ambiguity). Intentional asymmetry with `dedupe_ambiguous` replay (which uses stored `matchedCustomerId` and does NOT re-resolve) is documented — reflects the different payload shapes, not a smell.

**Pre-implementation Tenet #7 verification surfaced 3 findings** that shaped the design: (1) `findOrCreateCustomer` already does dedupe detection via its 5-value `action` discriminant; (2) `createInvoice` has no pricing param, so pricing validation must live in the route, BEFORE the `createInvoice` call; (3) two distinct contactId semantics exist (see "Identifier seam" below).

**Identifier seam (locked architectural detail).** The GHL contactId identifies *which client to bill* — used for pricing/charter/payload/audit. The QBO books-connection key is always `null` for Ledgerix Pro's own-QBO global connection — used in `findOrCreateCustomer` + `createInvoice` calls. The two identifiers are structurally separate. This seam parallels Decision 6's Q-pay-2 overloaded-`entityRef` split.

**Money convention (locked architectural detail).** Dollars in request body and `lineItems[].amount` (matches `qbo.createInvoice`'s QBO wire format and the Piece I replay path). Cents in all `*Cents`-suffixed pricing-decision/audit fields. Conversion uses **per-item rounding before summing**:

```ts
sentAmountCents = lineItems.reduce(
  (acc, li) => acc + Math.round(li.amount * 100),
  0,
);
```

NOT `Math.round(sum * 100)`. Per-item rounding eliminates JS float-add accumulation error (`0.1 + 0.2 ≠ 0.3`) that under the locked exact-zero-tolerance comparison (Q-inv-3-α) would spuriously escalate valid multi-line invoices to HITL. Regression-locked with a divergent `[2.675, 2.675]` test (per-item 536¢ vs pre-round 535¢) that fails 201-vs-202 if the rounding order regresses.

**Locked Session 5 (2026-05-28).** **FEATURE-COMPLETE Session 5.** Implementation arc:

- Lock commit `a328db6f`.
- Q-inv-3-β REVISED commit `7ac02b90`.
- **Piece H** (commit `287bb180`): `invoices-helpers.ts` — `evaluateInvoicePricing` + `confidenceForMatchType`. Pure-logic module: no db, no I/O, no upstream calls.
- **Piece I** (commit `441c8643`): approval-replay wiring for both invoice approval types. `dedupe_ambiguous` uses stored `matchedCustomerId`; `pricing_mismatch` re-resolves via `findOrCreateCustomer` (per REVISED Q-inv-3-β); ambiguous-on-replay drift escalates to `write_failed_replay`. Brings `executeApprovedAccountingWrite` to **4-of-4 wired**.
- **Piece J** was a NO-OP — verified at design lock that `findOrCreateCustomer` and `createInvoice` already had correct signatures from Phase 4b. Unlike Decision 6's Piece D (which required substantive service refactor), Decision 7's service layer needed no changes.
- **Piece K** (commit `9366445d`): POST `/api/accounting/v1/invoices` route — FEATURE-COMPLETE. Gate order: validate → dedupe → pricing → createInvoice. Two domain-specific 500 codes (`pricing_not_configured` + `setup_fee_not_configured`) for operational seeding gaps (NOT user-correctable 400s).

**Test trajectory.** 308 → 340 (+32 across the Decision 7 arc).

## Phase 4c.5 architectural Q-items

### Q-charter: Charter status storage mechanism

**LOCKED + IMPLEMENTED Session 4 (2026-05-27, commit `5b4856bb`)** as Option B — local DB table `client_charter_status` per Trust Tenet #14. Billing source-of-truth in our own DB; structural enforcement of the cancellation-forfeits-Charter rule via a status enum (`active` / `cancelled_was_charter` / `never_charter`).

Service module: `server/src/services/accounting/charter.ts`. Public functions:

- `isCharterForInvoicing(db, companyId, ghlContactId)` — the predicate used by Decision 7's pricing gate. **Defaults to `false` for unknown clients** (safe billing default).
- `getCharterStatus`, `grantCharterToNewClient`, `recordNonCharterClient`, `cancelCharter` — mutation/inspection helpers.

State-transition rules enforced at the service layer (3 typed error classes). Schema migration `0068_youthful_blockbuster.sql`. 20 tests.

**Deferred (operational, not architectural — tracked in Open Items below):** onboarding/cancellation workflow wiring. The Invoice endpoint READS charter status via `isCharterForInvoicing`; it does not write it. The grant/record/cancel functions exist but are not yet called from the onboarding agent's first-paying-client path or the cancellation flow.

### Q-setup-fee: Setup-fee pricing model

**LOCKED + IMPLEMENTED Session 4 (2026-05-27, commit `83b80a72`)** as Option B — parallel `setup_fee_pricing` table (NO `isCharter`, NO `contactId` columns per Q-setup-fee's design rule that setup fees don't vary by Charter status per EA Section 7). Aligns with Q-charter's "separate, structurally-correct modeling" design principle: each business concern gets its own table.

Service function `getSetupFeeCents(db, tier)` added to `server/src/services/accounting/pricing.ts` alongside `getExpectedPriceCents`. Seed values (EA Section 7): Foundation $249 / Growth Engine $349 / Scale-Up $1,200. Schema migration `0069_damp_bloodscream.sql`.

**Sub-decision Q2-α-i locked during implementation** (the `Q2-` prefix here is the WIP-doc Q-numbering label inherited from when Q-setup-fee was tracked as "WIP-doc Q2"; preserved as historically committed): the admin endpoint `POST /api/admin/pricing/seed` extended to combined response shape `{ data: { pricing: {...}, setupFees: {...} }, meta }` rather than separate endpoints — preserves per-table visibility in the response. 3 existing admin.test.ts tests updated for the new shape.

**Deferred (operational, not architectural — tracked in Open Items below):** production seed invocation. The endpoint and service function exist; production rows for `setup_fee_pricing` are not yet seeded. Until prod is seeded, the Invoice endpoint returns 500 with `setup_fee_not_configured` on setup-mode invoices.

### Q-multi-line-journals: Multi-line journal write semantics

**LOCKED + DELIBERATELY EXCLUDED Session 5 (2026-05-28)** as Option C — the Decision 5 exclusion of QBO `JournalEntry` and Xero `ManualJournal` from the write dispatcher is locked as **DELIBERATE**, not aspirational.

**Pre-lock Tenet #7 verification surfaced three findings:**

1. **Read-side already handles both types.** `fetchQboJournalEntry` (transaction-lookup.ts:318) and `fetchXeroManualJournal` (transaction-lookup.ts:617) are in production, registered in the read dispatcher. The asymmetry (readable, not writable) is observable today.
2. **Platform shapes differ structurally.** QBO `JournalEntry.Line[].JournalEntryLineDetail.PostingType` is `"Debit" | "Credit"` — debit/credit is type-tagged. Xero `ManualJournalLine.LineAmount` is signed (positive = debit, negative = credit). Any balance-preservation helper would need platform-specific representations, not a unified abstraction.
3. **No existing code creates journals.** No service function, no agent prompt, no script, no route. The agents that READ journals use them for analysis, not mutation.

**Three interpretations were considered:** narrow category-update with offsetting line update; multi-line journal create/replace; lock the exclusion as deliberate. The first two require solving design problems without use-case constraints to inform them. **Interpretation 3 chosen** — honest about what's known: no use case, no design.

**Locked behavior (current state — preserved):**

- `getTransactionById` continues to fetch QBO `JournalEntry` and Xero `ManualJournal` (read-side asymmetry is intentional — analysis is safe, mutation is not).
- `updateTransactionCategory` continues to throw `TransactionTypeNotCategorizableError` for both types — this error path is now LOCKED as the permanent v1 behavior, not a stub.
- No `POST /api/accounting/v1/journals` endpoint exists, is planned, or is referenced in the EA endpoint roster.
- Rare adjusting entries (month-end, depreciation, accruals) are performed manually by a human operator in QBO/Xero, not via the API.

**Reopen criteria (the door is deliberately left open).** Q-multi-line-journals reopens when ALL three are documented:

1. **A specific agent use case.** Named agent, specific operation (create new / update existing / replace lines), concrete frequency estimate.
2. **A real-world example transaction.** An actual journal entry the agent would write, with line-by-line debit/credit detail.
3. **A safety-gate sketch.** Which Phase 4c safety checks apply (threshold? approval-by-default? per-account whitelist?), informed by the use case's risk profile.

When all three exist, reopen with a new design lock in a fresh WIP doc explicitly scoped to journal-write semantics.

## Architectural patterns established during Phase 4c.5

These cross-Decision patterns emerged from Phase 4c.5 and are now established conventions future phases inherit. They are not specific to any single Decision; they are how the project does write-endpoint work.

- **Lock-then-implement.** All seven Decisions followed: WIP-doc design lock → implementation Pieces → closeout. No code shipped before the contract locked. This is the Phase 4c.5 workflow signature.
- **Verify before locking (Tenet #7).** Every Decision began with a code-grounded verify step. Saved at least two near-misses (Decision 7 caught the `InvoicePricingMismatchPayload` customerId gap; Decision 6 caught the entityRef overload; Decision 4's REVISED note caught the Xero shared-endpoint pattern). Pattern: "verify BEFORE estimating, not after recommending."
- **REVISED notes for locked-decision drift (Tenet #16).** When implementation surfaced gaps in a locked decision, the resolution was an explicit revision committed doc-first BEFORE the code change, not silent adaptation. The pattern was established by **Decision 2 REVISED** (admin auth — abandoned bespoke API-key in favor of reusing `assertInstanceAdmin`) and followed by **Q-inv-3-β REVISED** (Decision 7 — pricing_mismatch replay re-resolves customer). Two locked examples; both committed doc-first. Decision 4 also carries a REVISED note (Xero ACCREC/ACCPAY shared endpoint) — same discipline.
- **Route ↔ replay shared helpers.** Each write-endpoint Decision identified a helper shared between the route handler and the approval-replay path (`payments-helpers.ts` for Decision 6; `invoices-helpers.ts` for Decision 7). Single source of truth prevents two code paths from drifting on the same logic.
- **FK actor separation.** All approval rows distinguish `requestedByUserId` (board actors) from `requestedByAgentId` (agent actors), enforced at every approval-creation site. The pattern was caught pre-commit during Piece C and applied uniformly across Pieces G + K.
- **Identifier seams documented when overloaded.** Decision 6's Q-pay-2 split `entityRef` into typed `customerId?` / `accountId?`. Decision 7 documented the GHL-contactId-vs-`null`-QBO-books-key seam. Both were documented in code AND in this ADR because they are not obvious from signatures alone — a future reader needs the *why* alongside the *what*.
- **Money handling — explicit unit convention.** Decision 7 established: dollars in request bodies and QBO line items (matches wire format); cents in `*Cents`-suffixed audit fields; per-item rounding before summing for any comparison under zero-tolerance. Locked via a divergent regression test (`[2.675, 2.675]`).
- **Honest deferral over speculative design.** Q-multi-line-journals chose Option C (lock as deliberately excluded) over speculative designs that lacked use-case constraints. Mirrors ADR-001's "Pattern B Full" incremental endpoint-by-endpoint shipping rather than upfront breadth.

## Implementation outcome

- **8 of 8 Phase 4 endpoints production-ready** — 5 read endpoints from Phase 4a/4b + 3 write endpoints from Phase 4c.5 (`POST /transactions/:txnId/category`, `POST /payments`, `POST /invoices`).
- **2 admin endpoints shipped under `/api/admin/*`** (`POST /pricing/seed`, `POST /thresholds/seed`) — the Phase 4c.5 bootstrap surface for safety-layer data management (Decisions 1–3). Not part of the Phase 4 endpoint roster; admin surface is separate.
- **4 of 4 `executeApprovedAccountingWrite` approval-replay stubs wired** (transaction-category, payment-threshold, invoice-dedupe, invoice-pricing).
- **Test baseline:** 161 → 340 (+179 across Phase 4c + 4c.5).
- **All architectural decisions resolved.** Decisions 1–7 + Q-charter + Q-setup-fee + Q-multi-line-journals.
- The Phase 4c.5 WIP doc is archived (see `docs/wip/archived/phase-4c-5-write-endpoints-and-admin-api.md` after Migration Step 2).
- Full implementation arc captured chronologically in `docs/PHASE-4-PROGRESS.md` (Sessions 1–5).

## Open items (deferred work, tracked)

These are NOT Phase 4c.5 architectural items — they are downstream operational/integration items that Phase 4c.5 enabled or surfaced. Listed here so future work has a single canonical reference.

- **Q-charter — onboarding/cancellation workflow wiring.** Charter status service functions (`grantCharterToNewClient`, `recordNonCharterClient`, `cancelCharter`) exist and the read predicate (`isCharterForInvoicing`) is called by the invoice endpoint. The onboarding agent's first-paying-client path and the cancellation flow do NOT yet call the grant/record/cancel functions. Code work.
- **Q-setup-fee — production seed of `setup_fee_pricing`.** Local seeded; production not yet. Operational step via the admin endpoint `POST /api/admin/pricing/seed`. Until prod is seeded, setup-mode invoices return 500 with `setup_fee_not_configured`.
- **Billing & Invoicing agent reconciliation.** The Billing & Invoicing agent prompt + tool registration may not yet reflect Decision 7's request body (`billingMode` etc.) or the safety-gate responses (202 dedupe_ambiguous + 202 pricing_mismatch). Downstream-blocked by Q-setup-fee production seed.
- **EA §2B.4 supersession note already in place.** EA §2B.4's API Spec language ("no automatic validation" / "billing agent is responsible") was superseded by Decision 7; the supersession note landed inside the EA's Decision 7 entry (commit `ac58de83`) because EA does not quote §2B.4 verbatim.

## Amendments

(Empty. Reserved for future revisions to ADR-004 itself.)

## Status

Accepted. Phase 4c.5 architecturally complete. ADR-004 captures the canonical record; the WIP doc that this ADR distills is archived under `docs/wip/archived/` as of Migration Step 2.
