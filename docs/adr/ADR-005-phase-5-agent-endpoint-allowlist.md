# ADR-005: Phase 5 — Agent Endpoint Allowlist

**Status:** Accepted
**Date:** May 29, 2026
**Decision Maker:** Scott Hansbury (Founder)
**Supersedes:** None directly. Implements ADR-001 Phase 5 requirements (#30 per-agent DB keys; #32 per-agent endpoint allowlists).
**Related:** ADR-001 (Pattern B Full — originating Phase 5 requirements), ADR-004 (Phase 4c.5 write endpoints — the routes being gated), `docs/PHASE-4-PROGRESS.md` (chronological implementation log), `docs/LedgerixPro-Enterprise-Architecture.md` (architectural canon)

## Context

ADR-001 ("Pattern B Full") locked the multi-phase rebuild of Paperclip's agent execution model atop a stable HTTP API surface. Two requirements gate agent access to that surface:

- **#30 — Per-agent API key authentication.** Unique key per agent, stored in DB, authenticates every call.
- **#32 — Per-agent endpoint allowlists.** Each agent's grants specify which endpoints it may call; non-allowlisted calls are rejected.

These are Phase 5 of the ADR-001 arc. Phase 5 sits between Phase 4 (the HTTP API surface itself — completed by ADR-002/003/004) and Phases 6–8 (audit, rate-limiting/versioning/onboarding, script migration), which remain ahead.

**Key finding from a pre-implementation code read (2026-05-29):** most of what ADR-001 framed as net-new "Phase 5 agent API key infrastructure" ALREADY EXISTS in the Paperclip platform. Phase 5 was therefore an adoption + thin enforcement layer, not net-new construction:

- **Agent key auth — EXISTS.** `server/src/middleware/auth.ts` `actorMiddleware` resolves Bearer tokens (board key → agent key → agent JWT), SHA-256 hashes and looks up `agent_api_keys` (filtering `revokedAt IS NULL`), checks agent status, and attaches `req.actor = {type:"agent", agentId, companyId, keyId, source}`. Requirement #30 was already satisfied.
- **Allowlist storage — EXISTS.** `principal_permission_grants` table keyed `(companyId, principalType, principalId, permissionKey)` + `scope` jsonb. Already a live, multi-consumer grant system (`services/access.ts`, `routes/access.ts`, `routes/agents.ts`, `services/invite-grants.ts`).
- **Grant-check function — EXISTS.** `accessService(db).hasPermission(companyId, principalType, principalId, permissionKey)` (access.ts:55). Single indexed lookup. Already accepts `principalType` so "agent" slots next to "user".
- **Typed key enum — EXISTS.** `PERMISSION_KEYS` const at `packages/shared/src/constants.ts:431`; `PermissionKey` type + `z.enum(PERMISSION_KEYS)` validator already in place. Adding a key is a one-place edit that propagates.

The actual gap was narrow: (a) define accounting permission keys, (b) write a thin enforcement middleware that calls `hasPermission` with `req.actor`, (c) apply it to the agent-facing accounting write routes.

If left undone, agents would have key-authenticated access with NO per-endpoint bound — "API key access to every endpoint has the same blast radius as Bash" (ADR-001's Pattern B Lite rejection). The allowlist is the structural safety property the whole Pattern B Full arc exists for.

The WIP doc that this ADR distills (`docs/wip/phase-5-agent-endpoint-allowlist.md`) was retired in closeout step 4 (a separate commit). The chronological implementation log lives in `docs/PHASE-4-PROGRESS.md`.

## Naming convention note

ADR-005 uses Decision letters A–L (not numbers) to disambiguate from ADR-004's Decisions 1–7. The letters correspond directly to the WIP doc's locked decisions and group naturally:

- **A–D** — Allowlist scope and composition (key granularity, enforcement composition, non-agent handling, scope-vs-thresholds split).
- **E–H** — Middleware factory (signature, error mechanism, gate position, test shape).
- **I–L** — Route mount and test composition (key-to-route mapping, insertion mechanism, integration-test shape, test composition strategy).

## Decisions

### Group 1 — Allowlist scope and composition

#### Decision A: Permission-key granularity — per-operation (A1)

**Decision.** Three keys, one per existing write endpoint:

- `accounting:write_category`
- `accounting:create_payment`
- `accounting:create_invoice`

**Rationale.** Matches the existing `domain:action` vocabulary (`tasks:assign`, `agents:create`, `users:invite`, ...). Per-operation granularity IS the "bounded blast radius" ADR-001 line 46 calls out — an injected agent with only `write_category` cannot create payments. A single coarse `accounting:write` key would discard the granularity the allowlist exists to provide.

**Note on `accounting:create_invoice`.** The key is DEFINED now but its agent-exposure is gated by the deferred consumer-agent-identity item (ADR-001 Phase 5+ downstream / future own-billing agent). Defining the key now is harmless — no agent receives the grant until the invoice flow is agent-exposed. See Decision I1 (route mount) for the related "do not gate invoices yet" decision.

**Rejected.**
- A2: Single coarse `accounting:write` key — discards the granularity that justifies the allowlist.
- A3: Add `accounting:read` key now — read endpoints are not agent-exposed yet; YAGNI.

#### Decision B: Enforcement composition — per-route middleware factory (B1)

**Decision.** A `requireAgentPermission(permissionKey)` factory applied per-route AFTER `actorMiddleware`. Reads `req.actor`, calls `hasPermission`, returns 403 on miss.

**Rationale.** Explicit at the mount point; composes cleanly after the existing `actorMiddleware`; mirrors how existing guards attach; testable in isolation.

**Rejected.**
- B2: Catch-all router middleware with method→key map — hides the mapping in a table that drifts from routes.
- B3: Inline permission checks in handlers — scatters enforcement, untestable in isolation, easy to forget on new endpoints.

#### Decision C: Non-agent actor handling — agent-only enforcement (C1)

**Decision.** The permission check applies ONLY when `req.actor.type === "agent"`. Board operators, instance-admins, and `local_trusted` pass through, governed by their existing auth (`assertInstanceAdmin`, board_key, session).

**Rationale.** The allowlist's purpose is bounding AGENT blast radius. Human/admin paths already have their own auth; forcing grants on them would break the admin/local flows shipped in Phase 4c.5 for no safety gain.

**Rejected.**
- C2: Universal grant enforcement on all actors — breaks admin/local flows; no safety gain.

#### Decision D: `scope` jsonb usage — not now (D1)

**Decision.** Grants are binary (has key or doesn't). Amount-based limits stay in the Phase 4c.2 `write_thresholds` system (`isThresholdExceeded`, per-client overrides).

**Rationale.** Thresholds already own "how much can this agent move"; duplicating into grant `scope` would create two sources of truth — the split-brain the Trust Tenet warns against. Revisit `scope` only if a real need appears that thresholds cannot express.

**Rejected.**
- D2: Amount caps in grant `scope` jsonb — `write_thresholds` already owns amount limits; would create two sources of truth.

### Group 2 — Middleware factory (`requireAgentPermission`)

#### Decision E: Factory signature (E1)

**Decision.** `requireAgentPermission(db, permissionKey)` — closes over `db` at mount time, returns a `RequestHandler`. Lives in `server/src/middleware/` alongside `board-mutation-guard.ts` / `private-hostname-guard.ts`.

**Rationale.** Mirrors the existing `actorMiddleware(db, opts)` precedent (auth.ts:21) and the universal `accessService(db)` construction pattern (db via closure, never off `req`).

**Rejected.**
- E2: Curried `requireAgentPermission(db)(permissionKey)` — indirection for no gain over the direct two-arg factory.
- E3: Pull `accessService` off a `req`-attached handle — contradicts the established db-via-closure pattern.

#### Decision F: Error mechanism (F1)

**Decision.** Throw a typed Forbidden-family error (the same family `assertCompanyAccess` throws from `routes/authz.ts`); the central `errorHandler` formats the 403. NOT inline `res.status(403)`.

**Rationale.** The entire accounting surface routes 403s through thrown asserts + central error handler; inline status-setting would be the only place breaking that convention. The exact error class is `forbidden(message)` from `server/src/errors.ts` (returns `HttpError(403, message)`), reused — not a parallel class. Async errors propagate via Express 5 auto-catch (server pins `express ^5.1.0`); no try/catch wrapper is needed.

**Rejected.**
- F2: Inline `res.status(403).json(...)` in the middleware — only place breaking the throw-via-errorHandler convention; duplicates error-shape logic.

#### Decision G: Gate position — outer-wrapper extension of the locked accounting gate order (G1)

**Decision.** The permission check runs as route middleware BEFORE the handler. Effective gate order becomes:

```
requireAgentPermission → validate body → assertCompanyAccess → withIdempotency
```

**LOCKED-GATE-ORDER NOTE (load-bearing).** The accounting routes carry a `// Gate order (locked): validate body → assertCompanyAccess → withIdempotency` comment. Decision G PREPENDS an outer gate; the locked INNER sequence (validate → assertCompanyAccess → withIdempotency) is preserved intact and unchanged. **Adding an outer wrapper while preserving the locked inner order is an EXTENSION, not a reordering.** Approved knowingly with this distinction explicit.

**This outer-gate placement is empirically PROVEN by the 403-before-400 ordering tests** (see Decisions K/Implementation outcome below). An ungranted-agent request with an invalid body returns 403, not 400 — confirming the permission gate fires before body validation.

**Rationale.** Permission-to-invoke is the most fundamental gate; failing fast on a missing grant before body parse/validation is safer and cheaper, and is visible at the mount point.

**Rejected.**
- G2/G3: Permission gate after `assertCompanyAccess` / inside the handler — permission-to-invoke should fail fast before body parse/validation.

#### Decision H: Test coverage (H1)

**Decision.** Middleware unit tests (agent-with-grant → pass; agent-without-grant → 403; non-agent actor → pass-through per Decision C) PLUS per-route integration tests confirming the gate fires on the real accounting write routes.

**Rationale.** The non-agent pass-through branch (Decision C) is the subtle branch most likely to regress silently and warrants a dedicated unit test. Integration tests then prove the gate fires on the real route in the real chain.

**Rejected.**
- H2: Integration-tests-only — the non-agent pass-through branch needs a dedicated unit test to prevent silent regression.

### Group 3 — Route mount and test composition

#### Decision I: Key→route mapping — gate category and payments, NOT invoices (I1)

**Decision.** Gate the two agent-facing write routes now:

- `/accounting/v1/transactions/:txnId/category` → `accounting:write_category`
- `/accounting/v1/payments` → `accounting:create_payment`

**The `/accounting/v1/invoices` route is INTENTIONALLY ungated.** Per Decision A's note, `accounting:create_invoice` is defined but its agent-exposure is deferred (consumer-agent-identity, ADR-001 Phase 5+ downstream); the invoice flow is not agent-exposed. Gating it now would imply the route is agent-ready when it is not — a code/decision mismatch.

**DO NOT add the invoices gate in a future session without first exposing the invoice flow to agents** — its absence is intentional, not an oversight. The key definition is harmless ahead-of-need; the route mount is not.

**Rejected.**
- I2: Gate the invoices route now — would imply agent-readiness the invoice flow does not have.

#### Decision J: Insertion mechanism (J1)

**Decision.** Inline per-route middleware arg:

```ts
router.post(path, requireAgentPermission(db, key), handler);
```

**Rationale.** Two routes, two one-line additions, each visible at the route declaration (matches Decision B1). A wrapper helper for two call sites is premature abstraction.

**Rejected.**
- J2: Local wrapper helper for middleware insertion — premature abstraction for two call sites.

#### Decision K: Integration-test shape — 403-before-400 ordering proof (K1)

**Decision.** Per gated route, three assertions:

- (a) Agent-WITHOUT-grant → 403, handler never runs.
- (b) Agent-WITH-grant → reaches handler.
- (c) Non-agent actor (board/local) → unaffected (Decision C pass-through on the real route).

**Critical ordering assertion (proves Decision G).** The agent-without-grant request MUST send a body that would ALSO fail body-validation, and assert the response is **403 (permission gate) NOT 400 (validation)** — proving the permission gate is genuinely the OUTERMOST gate, firing before the locked inner `validate→assertCompanyAccess→withIdempotency` sequence. Asserting only the gate's presence (without the ordering proof) would not distinguish "gate exists" from "gate is outermost."

**Rationale.** Integration tests prove the gate fires on the real route in the real chain. The 403-before-400 assertion is what actually verifies the Decision G gate-order extension.

**Rejected.**
- K2: Integration-test one representative route only — both gated routes should carry the real-chain proof, especially the agent-without-grant handler-never-runs assertion.

#### Decision L: Route-mount test composition — vi.mock access service + mount real middleware (L1-revised)

**Decision.** Mock the access service via `vi.mock("../services/access.js", ...)` in `accounting.test.ts` so `accessService(db).hasPermission` is controllable per test; mount the REAL `requireAgentPermission` middleware on the gated write routes.

**Why this is the right composition.** The integration tests build the app with `fakeDb = {} as Db` and mock the accounting service layer; routes never touch a real DB. `requireAgentPermission(db, key)` calls `accessService(db).hasPermission(...)`, which runs a real Drizzle query — it would explode on the empty fakeDb. L1 mocks `accessService` so `hasPermission` is a controllable spy. Decision C's pass-through means non-agent actors short-circuit BEFORE `accessService(db)` is ever invoked through the gate, so board/none tests remain clean.

**REQUIRED SCOPE CORRECTION (verify-step finding).** L1 is NOT a zero-existing-test-change mount. A grep confirmed TWO pre-existing agent-actor tests sit on the gated write routes and expect the request to REACH the handler:

- `accounting.test.ts` (category describe) — "uses requestedByAgentId when actor is an agent"
- `accounting.test.ts` (payments describe) — "uses requestedByAgentId when actor is an agent and threshold is exceeded"

After the gate mounts, these tests hit `hasPermission`. They were updated to mock `hasPermission → true` (granted agent) so the request still reaches the handler as the tests intend. **Deliberate, not collateral** — recorded as a required scope correction before code per Tenet #16.

The read-route agent tests (GET transactions/bills/invoices/accounts/reports auth-and-authz blocks) are UNGATED (Decision I1) and untouched.

**Rejected.**
- L2: Dependency-inject `accessService` into the route factory — changes the locked `accountingRoutes(db)` signature; over-engineered.
- L3: Hand-stub the Drizzle query chain in the test `fakeDb` — brittle; tests that the mock was called, not real grant behavior.

## Load-bearing nuances (cross-decision)

Two facts are load-bearing enough to call out explicitly outside the decisions they emerge from:

- **The Decision G gate is an OUTER-WRAPPER extension of the locked accounting gate order — not a reordering.** The inner `validate → assertCompanyAccess → withIdempotency` sequence inside the handler is unchanged. The 403-before-400 K1 tests are the empirical proof of the outermost placement. If a future session changes the gate-order comment in `accounting.ts`, those K1 tests are the regression net.

- **The `/accounting/v1/invoices` route is INTENTIONALLY ungated pending consumer-agent identity.** The `accounting:create_invoice` key exists; the gate does not. Do not add the gate without first exposing the invoice flow to a named agent (tracked under ADR-004 § Open Items / ADR-001 Phase 5+).

## Consequences

- **Agent blast radius is structurally bounded on the two agent-facing accounting write routes.** Per ADR-001 line 46, this is the safety property the whole Pattern B Full arc exists for. An injected agent without `accounting:write_category` cannot reach the category route's handler. An agent with `write_category` but without `create_payment` cannot reach the payments handler.
- **Invoices remains ungated by design.** Future agent-exposure of the invoice flow requires (1) wiring the gate per Decision J, and (2) granting the key to the relevant agent.
- **Amount-limits remain owned by `write_thresholds`.** Decision D1 prevents grant `scope` from competing with the threshold system; the two systems compose orthogonally (allowlist gates "which endpoints," thresholds gate "how much").
- **Admin/local flows are unaffected.** Decision C1's pass-through means human board users, instance admins, and `local_trusted` callers continue to operate exactly as in Phase 4c.5.
- **The accounting test file now carries a top-level `vi.mock("../services/access.js", ...)` block.** Tests touching agent actors on category/payments routes set `hasPermissionMock.mockResolvedValue(true|false)` explicitly. Future tests for these routes should follow the same pattern.

## Implementation outcome

- **3 commits** (in order):
  - `a745fd23` — Step 1: added `accounting:write_category`, `accounting:create_payment`, `accounting:create_invoice` to `PERMISSION_KEYS` (`packages/shared/src/constants.ts`). Propagated through the `PermissionKey` type + `z.enum(PERMISSION_KEYS)` validator; the exhaustive `Record<PermissionKey, string>` label map in `ui/src/pages/CompanyAccess.tsx` was extended to match (compile-time confirmation the keys are load-bearing). All 20 packages typecheck clean.
  - `90ba922a` — Step 2: `requireAgentPermission(db, permissionKey)` middleware factory + 6 unit tests (`server/src/middleware/require-agent-permission.ts` + `.test.ts`). Not yet mounted.
  - `91772d7d` — Step 3: mounted the factory inline on the category + payments routes; added 4 K1 integration tests across both gated routes; updated 2 pre-existing agent write-route tests per L1-revised.
- **Test coverage:**
  - Middleware unit tests: 6 (agent-with-grant; agent-without-grant 403 with permissionKey in message; board pass-through; none pass-through; missing agentId; missing companyId).
  - Route integration tests: 4 new K1 tests across both gated routes (ungranted-agent 403 with the load-bearing 403-before-400 ordering assertion; non-agent pass-through asserting `hasPermission` not called) + 2 updated pre-existing agent tests.
- **Test baselines:** `require-agent-permission.test.ts` 6/6 green; `accounting.test.ts` 92 → 96 (+4 K1), all green. Server typecheck clean.
- **All architectural decisions resolved.** Decisions A–L (twelve total, organized into three groups).
- The Phase 5 WIP doc is archived under `docs/wip/archived/` as of closeout step 4 (a separate commit). The implementation arc is captured chronologically in `docs/PHASE-4-PROGRESS.md`.

## Open items (deferred work, tracked)

These are NOT Phase 5 architectural items — they are downstream operational/integration items Phase 5 either enabled or surfaced, or items that belong to later ADR-001 phases. Listed here so future work has a single canonical reference.

- **Consumer-agent identity for `POST /api/accounting/v1/invoices`** (carried forward from ADR-004 § Open Items, still unresolved as of 2026-05-29). No agent in `server/src/` yet calls this endpoint. When the consumer-agent identity is resolved and the invoice flow is exposed to that agent, Decision I1 unblocks: mount `requireAgentPermission(db, "accounting:create_invoice")` on the invoices route inline (Decision J1 pattern) and grant the key to the consumer agent.
- **Phase 6 — Audit log.** ADR-001 line 78 ("Audit log table, middleware, query capabilities"). Not done. Phase 5 enforces the allowlist; Phase 6 will record the call. Audit middleware can sit alongside `requireAgentPermission` in `server/src/middleware/` when shipped.
- **Phase 7 — Rate limiting, versioning strategy, agent onboarding.** ADR-001 line 79. Not done.
- **Phase 8 — Migration of 4 existing scripts to endpoint-based agent flows.** ADR-001 line 80. Not done. The agent allowlist gates the destination; Phase 8 migrates the source.

## Amendments

(Empty. Reserved for future revisions to ADR-005 itself.)

## Status

Accepted. Phase 5 of the ADR-001 Pattern B Full arc is architecturally complete and shipped. ADR-005 captures the canonical record; the WIP doc that this ADR distills is archived under `docs/wip/archived/` as of closeout step 4. Phases 6–8 of the ADR-001 arc remain ahead.
