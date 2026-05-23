# ADR-002: Phase 4b Write Endpoint Design Decisions

**Status:** Accepted
**Date:** May 23, 2026
**Decision Maker:** Scott Hansbury (Founder)
**Supersedes:** None
**Related:** ADR-001 (Pattern B Full), docs/PHASE-4-ACCOUNTING-API-SPEC.md

## Context

Phase 4b implements three write endpoints under `/api/accounting/v1/`:

- `POST /transactions/:txnId/category` — Update a transaction's chart-of-accounts category
- `POST /payments` — Apply a payment against an existing invoice
- `POST /invoices` — Create an invoice in Ledgerix Pro's own QBO for monthly client billing

The Phase 4 specification (`docs/PHASE-4-ACCOUNTING-API-SPEC.md`) settled the high-level architecture: idempotency-key header pattern with 24-hour window, audit logging to the existing `activity_log` table with a new `status` column, two-phase failure handling (pre-call vs upstream), and response envelope shape (`{data, meta}` with `platform`, `performedAt`, optional `idempotencyReplay`, and `auditLogId`).

Several decisions were left unresolved by the spec. They surfaced during Phase 4b foundation work on Saturday May 23 (migration 0064 + idempotency helper + activity-log status extension, commits `b6f076f0` and `5dbb7748`). This ADR documents the resolutions so Sunday's route implementation is mechanical execution rather than continued design.

## Decision

The following decisions apply to all three Phase 4b write endpoints unless explicitly noted.

### D1. Idempotency replay writes a NEW activity_log entry

When a write endpoint receives a duplicate idempotency-key (same body, within window) and returns the stored response, it writes a new `activity_log` row with `status="success"` and `details.idempotencyReplay=true`. The new row references the same `entityType` and `entityId` as the original. The new row's audit log ID is returned in `meta.auditLogId`, not the original's.

### D2. Two-phase failure semantics: upstream-first ordering with compensating audit log

Write endpoints execute in this order:

1. **Validate** request body, auth, contact access. On failure: return 4xx with NO audit log entry (validation failures are noise; logging them risks DDoS amplification).
2. **Call upstream** (QBO or Xero) first. On failure: write audit log entry with `status="failure"` and the sanitized upstream error, return 502 Bad Gateway with `code: "upstream_error"`.
3. **Write idempotency_keys row** AFTER upstream success. If this DB write fails after the upstream call succeeded, log a `critical` warning to the operational log, return success to the caller anyway. The upstream effect already happened; failing to record idempotency just means a retry will create a duplicate upstream effect.
4. **Write activity_log row** AFTER both upstream and idempotency_keys. Same compensating behavior: if it fails after the rest succeeded, log critical warning, return success. The audit trail being incomplete is bad but not as bad as denying the caller a success response for a write that already happened.

### D3. Validation library: continue inline checks for v1, no Zod

Read endpoints use inline `requireStringParam` + manual checks. Write endpoints continue the same pattern, just with more body validation. Zod is appropriate but its introduction is a separate refactor that should cover both reads and writes uniformly — not introduced mid-Phase-4. Tracked as a future improvement.

### D4. CashFlow stays in SupportedReportType, returns 501

`CashFlow` remains a value in the `SupportedReportType` union and returns 501 Not Implemented at the dispatcher. We do not remove it because (a) the spec defines it, (b) future Xero API changes might enable cross-platform support, (c) a QBO-only fallback could be added later if business need arises. The 501 behavior is the honest interim.

### D5. Audit log status="failure" only for failures that touched upstream

Validation failures (4xx with no upstream call) do NOT write audit log entries. Upstream failures (502s) DO write `status="failure"` entries. Idempotency conflicts (409s) DO write `status="failure"` entries because they represent a real client-side bug worth tracing. The principle: the audit log records actions attempted against external state, not request rejections at the API boundary.

### D6. Idempotency replay preserves the original status code

When a write is replayed, the response uses the stored `responseStatus` value verbatim. A replayed `POST /invoices` returns the original `201 Created` status, not `200 OK`. This contradicts the spec text but matches the spec's stated semantic intent ("replay of original response").

The `meta.idempotencyReplay=true` field disambiguates: a true 201 means "newly created"; a 201 with `idempotencyReplay=true` means "previously created, returning original response."

## Rationale

### D1 (replay writes NEW audit log)

Two reasonable positions exist. The replay-doesnt-log position is "the action already happened, don't duplicate the record." The replay-does-log position is "the FACT of the replay attempt is itself an event worth recording — for fraud investigation, for client communication, for debugging."

We choose log-the-replay because financial audit trails value completeness over compactness. A future auditor or client wanting to know "what calls did your system receive on date X" needs to see every received write request, not just the unique-by-idempotency-key set.

The added storage cost is negligible. Trial Balance reports contain hundreds of rows; one activity_log row per replay is rounding error.

### D2 (upstream-first ordering)

Three orderings were considered:

- **DB-first:** write idempotency_keys + activity_log first, then call upstream. Problem: if upstream fails, our DB has phantom records of writes that didn't happen.
- **Upstream-first:** call upstream first, then write DB rows. Problem: if DB writes fail after upstream succeeded, the next retry re-triggers the upstream effect (double-payment risk).
- **Atomic two-phase:** prepare locally, commit upstream, commit locally. Problem: not actually supported by external APIs; requires distributed transaction primitives we don't have.

We choose upstream-first because the consequences are asymmetric. A DB write failure after upstream success is a logging gap (recoverable from upstream's audit). A DB write that records "we did X" when X never actually happened upstream is a real-world correctness problem (might trigger downstream actions on phantom state).

The compensating behavior — return success to the caller when DB writes fail after upstream success — is the right trade because the caller's perspective is "did my write happen?" The answer is yes (upstream succeeded). Our incomplete bookkeeping shouldn't translate to a fake failure for the caller.

### D3 (inline validation, defer Zod)

Three reasons:

1. **Consistency.** Reads use inline checks. Mid-Phase introduction of Zod creates inconsistency that future maintainers will trip on.
2. **Risk.** A new library in critical-path write code, end-of-day, at the most architecturally important Phase 4 milestone is the wrong moment for novelty.
3. **Cost-benefit.** Zod's value is in complex validation (discriminated unions, recursive schemas, refinement). Our write bodies have ~5-7 fields each with simple type and range checks. Zod's overhead exceeds its benefit at this complexity.

The future refactor scope is a separate ADR.

### D4 (CashFlow stays as 501)

Removing CashFlow from the union now would require:
- Updating SupportedReportType
- Updating route validation (currently lists CashFlow as valid)
- Updating tests (currently 501 test uses CashFlow)
- Documenting the removal somewhere visible

Each change has risk. The 501 behavior is currently honest and stable. The cost of leaving it as 501 is one slightly misleading row in `SupportedReportType` — a documentation cost, not a correctness cost.

### D5 (audit log only for upstream-touching failures)

A common mistake in audit logging is logging everything, which makes the log unsearchable. The 100x-the-noise-for-1x-the-signal pattern.

Validation failures are high-volume and low-information (bot scanners hitting endpoints, typos, API consumers iterating). Audit logging them produces a log that overwhelms the genuinely important entries: actions that actually touched a client's books.

The exception for idempotency conflicts (409s) is because they represent a real client-side bug — same key, different body. That's worth a record so the agent owner can diagnose. Volume is naturally low.

### D6 (replay preserves original status)

The contradiction with the spec text is honest. The spec says "200 OK on replay" but also says "returns the original response." These are inconsistent for a 201-returning endpoint.

We resolve by treating "returns the original response" as the controlling semantic. The status code IS part of the original response. Replaying with a different code violates the "same response" guarantee.

The disambiguation field (`meta.idempotencyReplay`) is the right tool for distinguishing "newly created" from "previously created, returning original" — not the status code.

## Implications

### For Sunday's implementation

Sunday's route handler pattern, applied to all three write endpoints:

```typescript
router.post("/path", async (req, res) => {
  // 1. Validate (inline) — no audit log on failure
  const companyId = requireStringParam(req, "companyId");
  // ... other validation ...

  // 2. Check auth — no audit log on failure
  assertCompanyAccess(req, companyId);

  // 3. Run write with idempotency
  const result = await withIdempotency(db, { companyId, key, requestBody: req.body },
    async () => {
      try {
        // 4. Upstream call FIRST
        const upstreamResult = await serviceFunction(...);

        // 5. Audit log (success) AFTER upstream success
        const audit = await logActivity(db, { companyId, action: "...",
          entityType: "...", entityId: "...", status: "success",
          details: { before, after, reason } });

        return { status: 200, body: { ...upstreamResult, auditLogId: audit.id } };
      } catch (err) {
        // 6. Audit log (failure) BEFORE returning 502
        await logActivity(db, { companyId, ..., status: "failure",
          details: { errorCode: "...", errorMessage: "..." } });
        throw new HttpError(502, "Upstream error", { code: "upstream_error" });
      }
    });

  res.status(result.status).json({
    data: result.body,
    meta: {
      platform, performedAt: new Date().toISOString(),
      ...(result.replayed ? { idempotencyReplay: true } : {}),
      auditLogId: result.body.auditLogId,
    },
  });
});
```

### For testing

Write endpoint tests need to cover:
- Validation failures (no audit log assertion needed)
- Upstream failures (audit log entry asserted with status="failure")
- Successful writes (audit log entry asserted with status="success")
- Idempotency replay (audit log entry asserted; replay flag in meta)
- Idempotency conflict (409 + audit log entry with status="failure")
- Status code preservation on replay (201 stays 201, not 200)

Test helpers from read endpoints (`buildTestApp`, `localBoardActor`) extend directly. New helpers needed: mock the idempotency helper to control replay behavior in tests, mock `logActivity` to verify audit calls.

## Open Items

These were considered but deferred:

- **Rate limiting per write endpoint.** Spec didn't require it for v1. Implementation deferred to post-Phase-4 hardening.
- **Cleanup job for expired idempotency_keys rows.** Schema has the index; cron routine to delete expired rows is post-Phase-4.
- **`reconcilePayment` paymentDate parameter extension.** Spec flagged this; will be addressed inline during Sunday's payment endpoint work.
- **Zod adoption across read + write endpoints.** Separate refactor, separate ADR.

## Status

Accepted. To be applied during Phase 4b implementation (Sunday May 24, 2026).
