# WIP: Phase 6 — Audit & Retention (ADR-001 Pattern B Full)

**Status:** in_progress
**Started:** 2026-05-29
**Last updated:** 2026-05-29 — Decision T REVISED (accounting-writes-only identity capture; hot path untouched)
**Owner:** Scott Hansbury
**Related ADRs:** ADR-001 (Pattern B Full — Phase 6 requirements, line 34 + line 77). Strategic Plan "Phase 6b" (== our 6c). ADR-005 (Phase 5, just completed — preceding arc).
**Estimated remaining work:** Large — multi-arc (6c → 6a-0 → 6a-rest → 6b). Estimate refined per sub-phase.

## Context

- ADR-001 line 34 requires: every endpoint call recorded with agent identity, endpoint, params, status, timestamp; audit log "queryable for debugging and trust-building with clients." Line 77 summarizes Phase 6 as "audit log table, middleware, query capabilities."
- **THE GOVERNING BUSINESS NEED (Scott, 2026-05-29):** Ledgerix Pro handles client books in a litigious environment. It must be able to DEFINITIVELY defend itself when a past client claims "Ledgerix Pro did X/Y/Z to my books" — by pulling exactly what was or was not done, per tenant, across the previous 7 years. This reframed the whole phase from "comprehensive logging" to **litigation-grade audit trail.**

**Critical terminology pin.** This arc is referred to as **"ADR-001 Pattern B Full — Phase 6 (audit log, middleware, query capabilities)."** Its long-term-archival sub-piece is what the **Strategic Plan separately numbers as its own "Phase 6b (long-term data retention infrastructure — 7-year archival, encryption-at-rest, legal hold)."** **THESE ARE THE SAME BODY OF WORK.** To avoid the collision, this WIP doc and all commits use the labels **6a / 6b / 6c** as defined below; whenever **"Phase 6b" appears in the Strategic Plan it maps to our 6c**. Never use a bare "Phase 6b" in commits for this arc — use **"6c (archival)"**.

**Sub-phase labels (this WIP doc's vocabulary, used in all commits):**
- **6a** — the queryable-audit half of ADR-001 Phase 6 (middleware completeness backstop + per-tenant query + fidelity/standardize logging). Split internally into **6a-0** (archive-before-delete hook — fix the audit-destruction bleeding) and **6a-rest** (everything else under 6a).
- **6b** — integrity / tamper-evidence on the (now archive-backed) audit trail.
- **6c** — the archival half (Strategic Plan calls this "Phase 6b"). 7-year durable archive, encryption-at-rest, legal-hold mechanism. Split internally into **6c-code** (archival writer + format + encryption + legal-hold + lifecycle, against the existing StorageService abstraction) and **6c-infra** (real-world bucket provisioning + Railway prod config — Scott's vendor/cost decision).

**KEY FINDINGS from code reads (2026-05-29), which drove the decisions:**

1. **`activity_log` IS the audit table** (no separate `audit_log`). Columns already capture ADR-001 line-34 fields: `actorType`, `actorId`, `agentId`, `action`, `entityType`, `entityId`, `details` (jsonb), `status` (success/failure), `createdAt`, `companyId` (nullable, 4c.5 Decision B). The WRITE surface `logActivity(db, input)` is live and called across ~15 route files incl. all accounting writes. So "table" + "logging" requirements are effectively MET.
2. **The genuine gap per ADR-001 line 34 is the QUERYABLE read side** — only a narrow user-profile-activity query exists; no general per-tenant audit query.
3. **INTEGRITY THREAT: `activity_log` is NOT append-only** — two code sites actively DELETE audit rows: `companies.ts` `remove()` (cascade across ~24 child tables to satisfy FK before deleting the company) and `agents.ts` `remove()` (same pattern). This directly contradicts 7-year retention. Confirmed NOT a GDPR/erasure mechanism (docs: all clients US-based, no EU/GDPR exposure; deletes are plain referential-integrity cascades).
4. **`activity_log.companyId`/`agentId` are FOREIGN KEYS** to `companies`/`agents` — the audit is structurally chained to the live entity, which is WHY the cascade deletes it.
5. **A production-grade storage abstraction ALREADY EXISTS:** `server/src/storage/` with provider-registry + `local-disk-provider` + `s3-provider` (`@aws-sdk/client-s3`, configurable bucket / region / endpoint / prefix). Deploy docs confirm S3-compatible object storage (AWS S3, MinIO, R2) is the prod pattern. So durable external archival storage is a BUILT primitive, not greenfield.
6. **No archival bucket is provisioned in prod today** (Railway Postgres + Railway container backups, hourly/month-scale only — nowhere near 7 years). Legal-hold mechanism named in Strategic Plan, not implemented.

If this didn't get done: a litigation event against Ledgerix Pro for past-tenant book changes could not be answered with definitive records — exactly the trust-defining capability the Trust Tenet exists to support.

## Architecture Decisions Made

- **Decision A — Phase 6 framing = Option 5 (litigation-grade audit).** Locked 2026-05-29. Rejected Option 1 (query only), Option 2 (query + middleware), Option 4 (query + integrity). Reasoning: the business need is definitive legal defense, which requires completeness + fidelity + integrity (tamper-evidence) + retrievability + durability — not just logging. Generic request middleware is the LEAST load-bearing piece (it logs HTTP-level calls, not the rich business semantics that actually defend a claim); the existing rich `logActivity` details are the substance.
- **Decision B — Sub-phase decomposition + ORDER.** Locked 2026-05-29. **6c (archival infra) → 6a-0 (archive-before-delete; fix the audit-destruction) → 6a-rest (middleware completeness backstop + query capability + fidelity/standardize logging) → 6b (integrity/tamper-evidence).** Each sub-phase ships and closes independently.
- **Decision C — Reorder rationale (6c FIRST).** Locked 2026-05-29. Originally 6a-0 was to lead (stop the audit-deletion "bleeding"). But the Trust Tenet (no clients until the system is complete) means there is NO live client audit data being destroyed — the urgency justification evaporated. With urgency gone, the architecturally TRUEST design wins: Option 2 (archive-before-delete) is what the retention policy actually describes (operational DB may purge for performance; durable 7-year copy lives in archival). That makes 6c (the archive) the natural foundation to build first, so the archive-before-delete hook (6a-0) has a destination.
- **Decision D — Audit-survival approach = Option 2 (archive-before-delete).** Locked 2026-05-29. Rejected Option 1 (break the FK + denormalize identity, accumulate audit in operational DB) and Option 3 (soft-delete entities). Reasoning: Option 2 matches the retention policy as written; Option 1 was an expedient workaround justified only by an urgency that no longer exists.
- **Decision E — 6c approach = Option 3 (code/infra split).** Locked 2026-05-29. Build the archival layer (writer, format, encryption, legal-hold, lifecycle) as CODE targeting the existing `StorageService` abstraction now — runs on local-disk in dev/test, S3 in prod, exactly as the codebase already abstracts storage. Track bucket provisioning + prod config as a SEPARATE 6c-infra deliverable (Scott's real-world vendor/cost decision), which does NOT block 6c-code. Rejected Option 2 (provision bucket first — blocks code on procurement, contrary to how the system abstracts storage).

### 6c-code design decisions (locked 2026-05-29)

- **Decision P — Archival format & granularity (P1):** Per-tenant, per-time-window JSONL objects. Key structure follows the existing StorageService convention (`{companyId}/audit/{year}/{month}/...`); each line is one activity_log row WITH DENORMALIZED IDENTITY (company name + agent name as they were at the time of the action) so the record stands alone and is legible after the live company/agent entity is deleted. Rejected: per-row objects (millions of tiny objects, operationally/cost prohibitive); single rolling per-tenant object (append requires rewriting the whole object — fights immutability and any future Object Lock). Denormalized identity is non-negotiable for the litigation use case. Locked.
- **Decision Q — Encryption approach (Q1, app-level):** Encrypt the JSONL buffer with AES-256-GCM before putFile, mirroring the proven secrets pattern (`server/src/secrets/local-encrypted-provider.ts`: random IV per object, scheme-tagged, keyed by a master key). Chosen over S3 server-side encryption (SSE) because app-level is STORAGE-BACKEND-INDEPENDENT — the archive is encrypted identically on local-disk (dev/test) and S3 (prod), so the real encryption path is exercised in dev and doesn't depend on per-bucket SSE config. GCM's auth tag also gives tamper-DETECTION on the archive (a down-payment on 6b integrity).
  - **CRITICAL CAVEAT — KEY SURVIVABILITY IS LOAD-BEARING (added to 6c-infra pending):** App-level encryption means the master key is required to decrypt archives for the full 7 years. A lost key = unrecoverable archives = no producible evidence in litigation — the exact failure the whole arc exists to prevent. Therefore 7-year master-key management/escrow is a MANDATORY 6c-infra obligation, NOT optional. Q1 is correct ONLY if key survivability is guaranteed. (Q3 — app-level + SSE belt-and-suspenders — was considered and deferred; SSE does not mitigate app-level-key loss anyway, so the real mitigation is key escrow, tracked below.)
  Rejected: Q2 (SSE only — backend-dependent, plaintext in app, weaker tamper story). Locked (with the key-management obligation).
- **Decision R — Legal-hold mechanism (R1, app-level registry):** A DB table (e.g. `legal_holds`: tenant/companyId, reason, placedAt, placedBy, liftedAt) that the archival lifecycle/destruction logic consults — an archive under an active hold is never destroyed regardless of 7-year age. Chosen over S3 Object Lock (R2) because the existing S3 provider does NOT expose Object Lock/Retention/Legal Hold (only put/get/head/delete), so R2 would require extending the provider AND depend on un-built bucket config; and because the destruction decision is app-level anyway, so the hold check belongs beside it as a simple, testable, backend-independent DB lookup. Legal hold is a business state ('this tenant is under subpoena/IRS audit/dispute'), naturally a DB record. Rejected: R2 (S3 Object Lock — couples to un-built infra); R3 (defer hold entirely — the destruction logic should be born hold-aware). Locked.

### Decision S — Point-in-time identity capture (locked 2026-05-29)

**Decision: Option 2 — capture company name + agent name into the activity_log row AT WRITE TIME**, so every audit record carries the identity as it was at the moment of the action (not as re-derived later).

Rationale: P1 requires denormalized identity 'as it was at the time of the action' so the archive stands alone. A read confirmed logActivity does NOT snapshot names today — the row stores companyId/agentId (FKs) + an action-specific details jsonb; names live only in the mutable companies/agents tables. An archive-time join would collapse all history to the name as-of-archive/deletion, losing mid-engagement renames. For a litigation record where fidelity is the point, 'agent X did Z when the company was named Y-at-the-time' is stronger. Critically, there are NO client audit rows yet (no clients until the system is complete), so backfilling logActivity to snapshot identity going forward has ZERO legacy-data gap — every real client row gets point-in-time identity from day one. This is a rare clean window to do it right at the source.

Rejected: Option 1 (archive-time join — simpler, but loses mid-engagement identity history); Option 3 (hybrid/defer — no reason to defer given the clean no-data window).

**Storage shape (implementation form of S):** point-in-time identity is stored as DEDICATED, nullable columns on activity_log (e.g. `company_name_snapshot text`, `agent_name_snapshot text`), NOT inside the details jsonb. Reasoning: (a) details is run through sanitizeRecord + redactCurrentUserValue at write time — a company/agent name could be wrongly redacted by the username-censor; identity metadata must not be subject to that. (b) Point-in-time identity is structural audit metadata, not action detail — keeping it as typed columns is queryable and explicit, and the archive-writer reads it directly rather than digging through a blob. Cost: one additive nullable migration. Locked.

**Work-order consequence:** logActivity identity-capture is now a FOUNDATIONAL 6c-code piece, sequenced BEFORE the archive-writer (the writer reads what logActivity stores). logActivity must look up + store the current company/agent name at insert time; callers that pass companyId/agentId get the snapshot captured automatically inside logActivity (callers unchanged where possible).

**SCOPE NARROWED 2026-05-29 (consequence of T REVISED).** S's intent ('every real client audit row carries point-in-time identity') is narrowed to: every ACCOUNTING-WRITE audit row carries point-in-time identity (the litigation-defense-of-books surface). Non-accounting audit rows leave the snapshot columns NULL. The dedicated nullable columns added in 2a (commit 6a90fea6) remain correct and unchanged — nullable was already the right call; this only narrows WHICH rows populate them.

### Decision T — logActivity identity-capture mechanism (locked 2026-05-29)

**Decision: Option 3 (hybrid) — optional caller-supplied point-in-time names, with a lookup fallback when not supplied.**

Mechanism: extend LogActivityInput with optional `companyNameSnapshot?` / `agentNameSnapshot?`. In logActivity: if a name is supplied by the caller, store it directly (no query). If NOT supplied AND the corresponding id is present (companyId / agentId non-null), look it up (query companies/agents by id) and store the result. System-scoped rows (companyId null) and rows without agentId store null snapshots, as today.

Rationale — chosen over Option 1 (always lookup) and Option 2 (caller-supplied only):
- A conversation-search confirmed a real PATTERN of deferred-performance / v1-simplification decisions already accumulated on hot/agent paths: the unhinted getTransactionById multi-type probe loop (hintedType fast-path dropped), rate-limiting deferred to v2, caching deferred to v2, payments remainingBalance/invoiceStatus simplified out. Scott explicitly flagged concern about PILING ON further deferred-perf debt.
- logActivity is a HOT path: 142 call sites. Option 1 (always lookup) would add up to 2 extra DB round-trips PER audit write across all 142 sites — adding two more items to the known deferred-perf stack, on a constantly-firing path.
- Option 3 avoids that: the litigation-critical callers (accounting write paths) already hold the company/agent object, so they supply names with ZERO added queries — accurate point-in-time identity on exactly the records that matter most. The lookup fallback guarantees COMPLETENESS (no silent null-snapshot gaps) for the long tail of callers that don't supply names.
- Trade accepted: Option 3 is more code (two paths in logActivity) than Option 1. This deliberately trades invisible-future-perf-debt for visible-testable-complexity-now — the right trade given the established pattern of deferred costs.

Rejected: Option 1 (always lookup — simplest, but adds 2 queries × 142 hot-path sites to the deferred-perf pile); Option 2 (caller-supplied only — cheapest, but risks silent null-snapshot gaps in litigation-critical records if a caller isn't updated). Locked.

**Implementation note:** As callers are NOT all updated at once, the accounting write paths (litigation-critical) should be updated to supply names in the SAME work as the logActivity change or immediately after; the fallback covers correctness in the interim. No client rows exist yet, so there is no legacy gap regardless.

**REVISED 2026-05-29 (premise corrected, scope narrowed).** Verify-step finding: the litigation-critical accounting write callers (accounting.ts) hold companyId + req.actor.agentId — IDs ONLY, no name and no loaded company/agent object at the logActivity call site. T's original Option-3-hybrid premise ('accounting callers supply names with zero added query') is therefore FALSE — they cannot cheaply supply names. Revised decision: do NOT add the optional caller-supplied-name machinery to the general logActivity path, and do NOT impose a lookup on the 142-site hot surface. INSTEAD: confine point-in-time identity capture to the low-volume accounting write paths only — those callers perform the company/agent name lookup explicitly (low volume → the 142-site perf concern that drove T away from always-lookup does NOT apply here) and pass the resolved names to logActivity via the optional snapshot fields. Non-accounting audit rows store NULL snapshots (they don't carry the litigation-defense-of-books requirement). Net effect: the litigation fidelity lands exactly where the requirement bites (the books), the 142-site hot path gets ZERO added queries, and the implementation is simpler than the abandoned general hybrid. The optional companyNameSnapshot/agentNameSnapshot fields on LogActivityInput are RETAINED (the accounting callers use them to pass resolved names); what's dropped is the general in-logActivity lookup-fallback for the whole surface.

## Architecture Decisions Pending

- **6a-0 FK/cascade resolution detail** (depends on 6c existing): exact mechanism for archive-then-cascade. To be scoped at 6a-0.
- **6c-infra:** which durable store (AWS S3/Glacier, Cloudflare R2, etc.), cost, Railway config. SCOTT'S real-world decision.
- **6c-infra: 7-year master-key management / escrow** — MANDATORY consequence of Decision Q1 (app-level encryption). A lost key makes all archives unrecoverable. Mechanism TBD (key escrow, rotation strategy, recovery procedure). Scott's real-world decision; gates the PROD archival path's trustworthiness, not the dev/test build.

## Work Done (cumulative)

- (none yet — this WIP doc is the first artifact)

## Next Steps (in order)

1. ✅ DECISIONS LOCKED (P1/Q1/R1): 6c-code design (per-tenant JSONL + denormalized identity, app-level AES-256-GCM, app-level legal_holds registry).
2. Step 2 (6c-code implementation), in order: (2a) add legal_holds table + company_name_snapshot/agent_name_snapshot columns to activity_log (additive migration); (2b) **Decision T REVISED:** (i) retain the optional companyNameSnapshot/agentNameSnapshot fields on LogActivityInput; logActivity stores them if supplied, else null — NO general lookup-fallback in logActivity (142-site hot path untouched, zero added queries). (ii) In the accounting write paths ONLY, resolve the company name (by companyId) and agent name (by agentId when actor is agent) and pass them to logActivity. (iii) Tests: logActivity stores supplied snapshots / stores null when omitted (no query); accounting write path resolves + passes names; non-accounting callers unaffected (null snapshot). (2c) build the archive-writer service (query activity_log per tenant/window → read denormalized identity → JSONL serialize → AES-256-GCM encrypt → StorageService.putFile), local-disk dev/test backend; (2d) build the retrieval/read path; tests at each.
3. 6c-infra: provision durable bucket + Railway config (Scott).
4. 6a-0: archive-before-delete hook in `companies.remove()`/`agents.remove()`.
5. 6a-rest: completeness middleware + per-tenant audit query capability + fidelity/logging standardization.
6. 6b: integrity/tamper-evidence on the (now archive-backed) audit trail.
7. Closeout each sub-phase to ADR (likely an ADR-006, or amend ADR-001) + tracker/EA/Brief + archive this WIP.

## Blockers

- None blocking 6c-code. 6c-infra (bucket provisioning) is a tracked Scott-decision that gates only the PROD archival path, not dev/test build.

## NOT Doing (deliberately)

- **REJECTED: Phase 6 = query capability only (Option 1).** Reason: doesn't meet the litigation-defense need (no integrity, no durability).
- **REJECTED: Generic request-middleware as the primary audit mechanism (part of Option 2 framing).** Reason: logs HTTP-level calls, not the rich business semantics that defend a claim; the existing `logActivity` rich details are the substance. Middleware is only a completeness backstop (deferred into 6a-rest).
- **REJECTED: Break the `activity_log` FK + denormalize (audit-survival Option 1).** Reason: expedient workaround; leaves audit in wrong tier accumulating; justified only by an urgency that the no-clients-until-complete principle removes.
- **REJECTED: Soft-delete entities (audit-survival Option 3).** Reason: doesn't solve retention; bloats all tables; archive status already exists for the non-destructive case.
- **REJECTED: Provision bucket before building 6c-code (6c Option 2).** Reason: blocks code on procurement; contrary to the system's storage-abstraction pattern.
- **REJECTED: Per-row or single-rolling-object archive format (Decision P alternatives).** Reasons: per-row = millions of tiny objects; single-rolling = rewrite-to-append fights immutability.
- **REJECTED: SSE-only encryption (Decision Q2).** Reason: backend-dependent, plaintext in app, weaker tamper story; and SSE doesn't mitigate app-level master-key loss.
- **REJECTED: S3 Object Lock for legal hold (Decision R2).** Reason: existing S3 provider doesn't expose it; couples legal-hold to un-built bucket config; destruction logic is app-level anyway.
- **REJECTED: Defer legal-hold entirely (Decision R3).** Reason: destruction logic should be born hold-aware.
- **REJECTED: logActivity always-lookup for identity (Decision T Option 1).** Reason: 2 extra DB round-trips × 142 hot-path call sites — adds to the established deferred-perf-debt pattern Scott flagged. Avoid piling on.
- **REJECTED: caller-supplied-only, no fallback (Decision T Option 2).** Reason: risks silent null-snapshot gaps in litigation-critical records if a caller isn't updated.
- **REVISED-AWAY: general in-logActivity lookup-fallback across all 142 callers (T original Option 3 mechanism).** 2026-05-29. Reason: premise was wrong (accounting callers hold ids not names); and a general fallback would impose lookups on the 142-site hot path. Point-in-time identity confined to the low-volume accounting writes instead.

## Session Log

### Session 1 — 2026-05-29

- Phase 6 opened after Phase 5 closeout + the three cleanups (HEAD `f3aa3dbc`).
- Read-before-scope established: `activity_log` is the audit table + `logActivity` is the live write surface (table+logging MET); the gap is the queryable read side. Discovered the two cascade-delete sites destroying audit (NOT GDPR — plain FK cascade). Discovered the existing S3-capable `StorageService` abstraction.
- Scott reframed the phase around the actual business need (definitive 7-year per-tenant litigation defense), twice going back to the business constraint — which changed the answer both times (→ Option 5; → 6c-first reorder).
- Locked: Option 5 framing; 6a/6b/6c decomposition reordered to 6c-first; Option 2 (archive-before-delete) design; Option 3 (code/infra split) for 6c.
- State: decision trail recorded; no code yet. Next entry point = scope 6c-code design decisions (format, encryption, legal-hold).
- Locked 6c-code design P1/Q1/R1 (per-tenant date-windowed JSONL with denormalized identity; app-level AES-256-GCM mirroring the secrets module; app-level legal_holds registry). Flagged Q1's key-survivability risk: app-level encryption makes 7-year master-key escrow a MANDATORY 6c-infra obligation (lost key = unrecoverable evidence). Confirmed via read that the existing StorageService is already per-tenant/date-partitioned/sha256, and the S3 provider does NOT expose Object Lock (closing the R2 fork). Next: implement 6c-code against StorageService with local-disk dev/test backend.
- Locked Decision S (Option 2): capture company/agent name into activity_log at write time as dedicated nullable columns (not details jsonb — avoids the username-redaction pass and keeps identity as typed audit metadata). Read confirmed logActivity does not snapshot names today; no client rows exist yet, so write-time capture has zero legacy gap. Work-order consequence: logActivity identity-capture is foundational, sequenced before the archive-writer.
- Locked Decision T (Option 3 hybrid): optional caller-supplied names + lookup fallback in logActivity. Chosen over always-lookup specifically to AVOID piling onto the known deferred-perf-debt pattern (conversation-search confirmed: unhinted probe loop, deferred rate-limiting/caching, simplified payments fields) on the 142-caller hot path. Litigation-critical accounting callers supply names (zero added query); fallback guarantees completeness elsewhere.
- Decision T REVISED (doc-first, Tenet #16): verify-step found accounting callers hold IDs not names (T's zero-query premise was false). Revised to confine point-in-time identity capture to the low-volume accounting write paths (explicit name lookup there, names passed via the retained optional snapshot fields); dropped the general in-logActivity fallback so the 142-site hot path gets zero added queries. Decision S scope narrowed accordingly (accounting-write rows carry snapshots; others null). 2a columns unchanged.
