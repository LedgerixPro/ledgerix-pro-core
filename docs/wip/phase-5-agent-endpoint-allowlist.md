# WIP: Phase 5 — Agent Endpoint Allowlist (ADR-001 Pattern B Full)

**Status:** in_progress
**Started:** 2026-05-29
**Last updated:** 2026-05-29 — step-2 decisions E1/F1/G1/H1 locked
**Owner:** Scott Hansbury
**Related ADRs:** ADR-001 (`docs/adr/ADR-001-pattern-b-full-api-endpoints.md`) — locks the Phase 5 requirements; ADR-004 (`docs/adr/ADR-004-phase-4c-5-write-endpoint-implementation.md`) — the write endpoints being gated.
**Estimated remaining work:** ~3–5 hours (estimate may shrink — most key/auth infrastructure already exists; see Context).

## Context

ADR-001 requirements #30 ("unique API key per agent, stored in DB, authenticates every call") and #32 ("per-agent endpoint allowlists; non-allowlisted calls rejected") gate agent access to the `/api/accounting/v1/*` write endpoints.

KEY FINDING (verified by code read 2026-05-29): most of what ADR-001 framed as net-new "Phase 5 agent API key infrastructure" ALREADY EXISTS in the Paperclip platform. Phase 5 is largely adoption, not construction:

- **Agent key auth — EXISTS.** `server/src/middleware/auth.ts` `actorMiddleware` resolves Bearer tokens (board key → agent key → agent JWT), SHA-256 hashes and looks up `agent_api_keys` (filtering `revokedAt IS NULL`), checks agent status, and attaches `req.actor = {type:"agent", agentId, companyId, keyId, source}`. Requirement #30 is DONE.
- **Allowlist storage — EXISTS as a live, multi-consumer grant system.** `principal_permission_grants` table keyed `(companyId, principalType, principalId, permissionKey)` + `scope` jsonb. Consumed by `services/access.ts`, `routes/access.ts`, `routes/agents.ts`, `services/invite-grants.ts`; tested in `access-service.test.ts`, `invite-join-grants.test.ts`, `routines-e2e.test.ts`. Existing `domain:action` key vocabulary: `tasks:assign`, `agents:create`, `users:invite`, etc.
- **Grant-check function — EXISTS.** `accessService(db).hasPermission(companyId, principalType, principalId, permissionKey)` (access.ts:55) — single indexed lookup on the unique-index columns; already accepts `principalType` (so "agent" slots next to "user") and a typed `PermissionKey`.
- **Typed key enum — EXISTS.** `PERMISSION_KEYS` const array at `packages/shared/src/constants.ts:431`; `PermissionKey` derived from it; Zod `z.enum(PERMISSION_KEYS)` validator at `packages/shared/src/validators/access.ts:91`. Adding keys is a one-place edit that propagates to type + validator.

The actual gap is narrow: (a) define accounting permission keys, (b) write thin enforcement middleware that calls the existing `hasPermission` with `req.actor`, (c) apply it to the accounting write routes.

If this didn't get done: agents would have key-authenticated access with NO per-endpoint bound — "API key access to every endpoint has the same blast radius as Bash" (ADR-001 Pattern B Lite rejection). The allowlist is the structural safety property the whole Pattern B Full arc exists for.

## Architecture Decisions Made

- **Decision A — Permission-key granularity: per-operation (Option A1).** Three keys, one per existing write endpoint: `accounting:write_category`, `accounting:create_payment`, `accounting:create_invoice`. Reasoning: matches the existing `domain:action` vocabulary; per-operation granularity IS the "bounded blast radius" (ADR-001 line 46) — an injected agent with only `write_category` cannot create payments. Locked: 2026-05-29.
  - NOTE: `accounting:create_invoice` is DEFINED now but its agent-exposure is gated by the deferred consumer-agent-identity item (ADR-001 Phase 5+ downstream / future own-billing agent). Defining the key now is harmless — no agent receives the grant until the invoice flow is agent-exposed.
- **Decision B — Enforcement composition: per-route middleware factory (Option B1).** A `requireAgentPermission(permissionKey)` factory applied per-route AFTER `actorMiddleware`; reads `req.actor`, calls `hasPermission`, returns 403 on miss. Reasoning: explicit at the mount point; composes cleanly after existing `actorMiddleware`; mirrors how existing guards attach; testable in isolation. Locked: 2026-05-29.
- **Decision C — Non-agent actor handling: agent-only enforcement (Option C1).** The permission check applies ONLY when `req.actor.type === "agent"`. Board operators, instance-admins, and `local_trusted` pass through, governed by their existing auth (`assertInstanceAdmin`, board_key, session). Reasoning: the allowlist's purpose is bounding AGENT blast radius; human/admin paths already have their own auth and forcing grants on them would break the admin/local flows shipped in 4c.5 for no safety gain. Locked: 2026-05-29.
- **Decision D — `scope` jsonb usage: not now (Option D1).** Grants are binary (has key or doesn't). Amount-based limits stay in the Phase 4c.2 `write_thresholds` system (`isThresholdExceeded`, per-client overrides). Reasoning: thresholds already own "how much can this agent move"; duplicating into grant `scope` would create two sources of truth — the split-brain the Trust Tenet warns against. Revisit `scope` only if a real need appears that thresholds cannot express. Locked: 2026-05-29.

### Step 2 implementation decisions (locked 2026-05-29)

- **Decision E — Factory signature (Option E1):** `requireAgentPermission(db, permissionKey)` — closes over `db` at mount time, returns a `RequestHandler`. Reasoning: mirrors the existing `actorMiddleware(db, opts)` precedent (app.ts:171) and the universal `accessService(db)` construction pattern (db via closure, never off `req`). Lives in `server/src/middleware/` alongside `board-mutation-guard.ts` / `private-hostname-guard.ts`. Locked.
- **Decision F — Error mechanism (Option F1):** Throw a typed Forbidden-family error (the same family `assertCompanyAccess` throws from `routes/authz.ts`); the central `errorHandler` (app.ts:444) formats the 403. NOT inline `res.status(403)`. Reasoning: the entire accounting surface routes 403s through thrown asserts + central error handler; inline status-setting would be the only place breaking that convention. Exact error class to reuse is confirmed by reading `routes/authz.ts` at implementation time (must reuse, not invent a parallel class). Locked.
- **Decision G — Gate position (Option G1):** The permission check runs as route middleware BEFORE the handler. Effective gate order becomes: `requireAgentPermission → validate body → assertCompanyAccess → withIdempotency`. Reasoning: permission-to-invoke is the most fundamental gate; failing fast on a missing grant before body parse/validation is safer and cheaper, and is visible at the mount point (Decision B1).
  - **LOCKED-GATE-ORDER NOTE (important):** accounting.ts:939 carries `// Gate order (locked): validate body → assertCompanyAccess → withIdempotency`. Decision G PREPENDS an outer gate; the locked INNER sequence (validate → assertCompanyAccess → withIdempotency) is preserved intact and unchanged. Per the locked-decisions tenet, adding an outer wrapper while preserving the locked inner order is an EXTENSION, not a reordering. Approved knowingly by Scott 2026-05-29 with this distinction explicit. Locked.
- **Decision H — Test coverage (Option H1):** Middleware unit tests (agent-with-grant → pass; agent-without-grant → 403; non-agent actor → pass-through per Decision C) PLUS per-route integration tests confirming the gate fires on the real accounting write routes. Reasoning: matches WIP step 4 + the codebase middleware-test pattern (board-mutation-guard.test.ts). The non-agent pass-through branch (Decision C) specifically needs a dedicated unit test — it's the subtle branch most likely to regress silently. Locked.

## Architecture Decisions Pending

None blocking. (The `accounting:create_invoice` agent-exposure dependency is tracked under ADR-001 Phase 5+ downstream, not as a Phase 5 blocker — the key is defined here regardless.)

## Work Done (cumulative)

- `8fe2f7d8` — Phase 5 WIP doc stood up (decisions A1/B1/C1/D1 locked).
- `a745fd23` — Step 1: added 3 accounting permission keys to PERMISSION_KEYS (`accounting:write_category`, `accounting:create_payment`, `accounting:create_invoice`) in packages/shared/src/constants.ts. Type-system propagation verified — the exhaustive `Record<PermissionKey, string>` label map at ui/src/pages/CompanyAccess.tsx forced human labels for all 3 keys (compile-time confirmation the keys are load-bearing, not just string literals). All 20 packages typecheck clean.

## Next Steps (in order)

1. ✅ DONE (a745fd23): Add the three accounting permission keys to `PERMISSION_KEYS` in `packages/shared/src/constants.ts` (propagates to `PermissionKey` type + Zod validator automatically). Verify build/typecheck after.
2. ✅ DECISIONS LOCKED (E1/F1/G1/H1): Write the `requireAgentPermission(db, permissionKey)` middleware factory in server/src/middleware/. Reads `req.actor`; if `type !== "agent"` pass through (Decision C); else call `accessService(db).hasPermission(companyId, "agent", agentId, permissionKey)` and throw Forbidden on miss (Decision F). Implementation entry point: first read routes/authz.ts to confirm the Forbidden error class to reuse.
3. Apply the factory to the `/api/accounting/v1/*` write routes (category, payments; invoice route key wired but agent-exposure deferred per Decision A note).
4. Tests: middleware unit tests (agent-with-grant 200-path, agent-without-grant 403, non-agent pass-through) + route integration tests.
5. Closeout: migrate locked decisions to an ADR (or amend ADR-001), summarize in PHASE-4-PROGRESS.md, update EA/Brief, archive this WIP doc.

## Blockers

None.

## NOT Doing (deliberately)

- **REJECTED: Build a new agent-key / auth system.** Considered 2026-05-29. Reason: `agent_api_keys` + `actorMiddleware` already implement it. Don't re-propose.
- **REJECTED: Use `agents.permissions` jsonb for the endpoint allowlist.** Considered 2026-05-29. Reason: it only carries the coarse `canCreateAgents` bit (per `agent-permissions.ts` `normalizeAgentPermissions`); unindexed for permission lookup, untyped. The grant table is the right home.
- **REJECTED: Single coarse `accounting:write` key (Decision A Option 2).** Reason: discards the granularity that justifies the allowlist.
- **REJECTED: Add `accounting:read` key now (Decision A Option 3).** Reason: read endpoints aren't agent-exposed yet — YAGNI; add in the phase that exposes them.
- **REJECTED: Catch-all router middleware with method→key map (Decision B Option 2).** Reason: hides the mapping in a table that drifts from routes.
- **REJECTED: Inline permission checks in handlers (Decision B Option 3).** Reason: scatters enforcement, untestable in isolation, easy to forget on new endpoints.
- **REJECTED: Universal grant enforcement on all actors (Decision C Option 2).** Reason: breaks admin/local flows; no safety gain — humans/admins have their own auth.
- **REJECTED: Amount caps in grant `scope` jsonb (Decision D Option 2).** Reason: `write_thresholds` already owns amount limits; would create two sources of truth.
- **REJECTED: Curried `requireAgentPermission(db)(permissionKey)` (Decision E Option 2).** Considered 2026-05-29. Reason: indirection for no gain over the direct two-arg factory.
- **REJECTED: Pull `accessService` off a `req`-attached handle (Decision E Option 3).** Reason: contradicts the established db-via-closure pattern.
- **REJECTED: Inline `res.status(403).json(...)` in the middleware (Decision F Option 2).** Reason: would be the only place breaking the throw-via-errorHandler convention; duplicates error-shape logic.
- **REJECTED: Permission gate after `assertCompanyAccess` / inside the handler (Decision G Options 2 & 3).** Reason: permission-to-invoke should fail fast before body parse/validation.
- **REJECTED: Integration-tests-only (Decision H Option 2).** Reason: the non-agent pass-through branch needs a dedicated unit test to prevent silent regression.

## Session Log

### Session 1 — 2026-05-29

- Resumed after Phase 4c.5 close (HEAD bae1a4e1). Confirmed state, diagnosed the 31 full-suite failures as pre-existing agent-runtime parallel-contention timeouts (not regression, not on accounting path — logged as tech debt; "340" closeout claim rescoped).
- Selected Phase 5 (agent endpoint allowlist) as the next ADR-001 arc.
- Read-before-scope: discovered the agent-key auth + grant system + typed permission-key enum + `hasPermission` already exist. Rescoped Phase 5 from "build infrastructure" to "adopt existing grant system + add thin enforcement."
- Locked Decisions A1 / B1 / C1 / D1 (above).
- Shipped: this WIP doc (`8fe2f7d8`); step 1 — accounting permission keys added to PERMISSION_KEYS (`a745fd23`).
- State at session end: decisions locked; step 1 (permission keys) shipped + typecheck-verified; Next Steps step 2 (requireAgentPermission middleware factory) is the next entry point.
- Locked step-2 implementation decisions E1/F1/G1/H1 (factory signature, throw-via-errorHandler error mechanism, permission-gate-before-handler as an outer-wrapper extension of the locked gate order, unit+integration test shape). Recorded before code per Tenet #16.
