# WIP: Phase 6 — Audit & Retention (ADR-001 Pattern B Full)

**Status:** in_progress
**Started:** 2026-05-29
**Last updated:** 2026-05-29 (decision trail recorded; no code yet)
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

## Architecture Decisions Pending

- **6c-code encryption design:** S3 server-side encryption vs. app-level encryption (master key). To be scoped before 6c-code implementation.
- **6c-code legal-hold mechanism design:** how a tenant's archive is marked hold-exempt from the 7-year destruction clock. To be scoped.
- **6c-code archival format:** per-tenant vs per-window object granularity; JSONL vs other; what identity is denormalized into the archive so it's legible after the live entity is gone. To be scoped.
- **6a-0 FK/cascade resolution detail** (depends on 6c existing): exact mechanism for archive-then-cascade. To be scoped at 6a-0.
- **6c-infra:** which durable store (AWS S3/Glacier, Cloudflare R2, etc.), cost, Railway config. SCOTT'S real-world decision.

## Work Done (cumulative)

- (none yet — this WIP doc is the first artifact)

## Next Steps (in order)

1. Scope 6c-code design decisions (archival format, encryption, legal-hold) — present as options with tradeoffs, lock before code.
2. Implement 6c-code archival layer against `StorageService` (local-disk dev/test backend).
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

## Session Log

### Session 1 — 2026-05-29

- Phase 6 opened after Phase 5 closeout + the three cleanups (HEAD `f3aa3dbc`).
- Read-before-scope established: `activity_log` is the audit table + `logActivity` is the live write surface (table+logging MET); the gap is the queryable read side. Discovered the two cascade-delete sites destroying audit (NOT GDPR — plain FK cascade). Discovered the existing S3-capable `StorageService` abstraction.
- Scott reframed the phase around the actual business need (definitive 7-year per-tenant litigation defense), twice going back to the business constraint — which changed the answer both times (→ Option 5; → 6c-first reorder).
- Locked: Option 5 framing; 6a/6b/6c decomposition reordered to 6c-first; Option 2 (archive-before-delete) design; Option 3 (code/infra split) for 6c.
- State: decision trail recorded; no code yet. Next entry point = scope 6c-code design decisions (format, encryption, legal-hold).
