# ADR-001: Pattern B Full — API Endpoints as Primary Agent Interface

**Status:** Accepted
**Date:** May 17, 2026
**Decision Maker:** Scott Hansbury (Founder)
**Supersedes:** None

## Context

Ledgerix Pro's agent architecture historically used standalone TypeScript scripts (in `/scripts/`) as the operational layer for agent tasks. Agents invoked scripts via Bash tool calls; scripts directly imported services and called external APIs (GHL, QBO, Xero).

The May 11-17, 2026 hallucination incident exposed structural problems with this approach:

- A local dev environment fired routines that invoked scripts holding production credentials, sending 7+ days of hallucinated overdue-bill emails. The architecture had no boundary preventing this.
- Agents had Bash tool access with no per-agent permission scope. Worst-case blast radius was "anything Bash can do."
- Scripts had hardcoded production identifiers (GHL location ID, contact IDs).
- No structured audit trail of agent operations existed.
- The same operations would need duplicate implementations for future client portals, third-party integrations, and external consumers.

Concurrent with this incident, Phase 4 work began building a versioned API surface (`/api/accounting/v1/*`) intended for human-facing consumers. The question emerged: should this API surface also become the primary interface for agent operations, replacing direct script-based service calls?

## Decision

**Adopt Pattern B Full: API endpoints become the single primary interface for all agent operations, with comprehensive supporting infrastructure.**

Specifically:

1. **All agent operations route through versioned API endpoints.** Agents do not call services directly and do not invoke standalone scripts. The Bash tool is removed from agent permissions (or restricted to a tightly-scoped whitelist).

2. **Agent authentication via API keys.** Each agent has a unique API key stored in the database. Keys authenticate every API call.

3. **Per-agent endpoint allowlists.** Each agent has an explicit list of endpoints it may call. Calls to non-allowlisted endpoints are rejected.

4. **Comprehensive audit logging.** Every endpoint call is recorded with agent identity, endpoint, parameters, response status, and timestamp. The audit log is queryable for debugging and trust-building with clients.

5. **Operational maturity.** Rate limiting per agent, documented versioning strategy, and a defined process for agent onboarding (key generation, allowlist configuration).

6. **Migration path.** Existing scripts (`ap-daily-scan.ts`, `ap-weekly-summary.ts`, `historical-sync.ts`, `sentinel-daily-run.ts`) will be rewritten as agent flows using API endpoints. Scripts are deleted once their endpoint-based replacements ship.

## Rationale

The decision favors structural safety over implementation simplicity. Key reasoning:

**Hallucination defense.** API endpoints enforce request schemas. An agent hallucinating "send an overdue notice for bill X" must produce a request that validates against the endpoint's schema, which requires a valid `billId` referencing real database state. Hallucinated data fails validation before it can cause damage. Scripts cannot enforce this — they accept whatever the agent passes.

**Bounded blast radius.** Per-agent endpoint allowlists give every agent a structurally bounded surface area. If an agent goes off the rails or is prompt-injected, it can only do what its allowlist permits. With scripts and Bash access, blast radius is "anything Bash can do."

**Trust and auditability.** A queryable audit log of every operation is essential for a financial product where clients trust the system with their books. Pattern B builds this in structurally. Pattern A would require manual logging across every script. The founder confirmed that for a real (non-beta) client, a single incident of hallucinated financial communications would result in immediate cancellation — establishing trust failure as a binary outcome in this product domain.

**Long-term operational scale.** At the target 50-client lifestyle business scale running on 14 hrs/wk operational time, structural safety properties matter more than implementation speed. Validated, audited endpoints with bounded permission scopes are easier to operate hands-off than fragile scripts requiring discipline.

**Compounding platform value.** Endpoints built for agent consumption are simultaneously usable by future human-facing portals, third-party integrations, mobile apps, and external developers. Script-based work produces only script-specific value.

The founder explicitly chose Pattern B Full over Pattern B Lite, accepting the additional implementation work in exchange for the structural safety properties that per-agent permissions, rate limiting, and comprehensive auditing provide.

## Consequences

### Positive

- Hallucinated operations fail at the API validation layer rather than reaching external services
- Per-agent permission scopes prevent prompt-injection or rogue-agent blast radius
- Built-in audit trail for trust, debugging, and client transparency
- Single API surface for agents, future portals, integrations, and external consumers
- Cleaner separation between agent reasoning (in prompts) and operational logic (in endpoints)

### Negative / Accepted Costs

- Multi-week implementation effort before BROKEN agents can be re-enabled
- HTTP layer adds small latency overhead per operation (~50-200ms per call)
- Requires building auth, permissions, audit, and rate-limit infrastructure
- API versioning discipline required — interface contracts become harder to change once external consumers exist
- Negligible ongoing real cost increase (~$5-15/month compute + storage at 50 clients)

### Affected Work

- Phase 4 (API endpoints): Remaining 7 endpoints + Vitest tests for all 8
- Phase 5 (new): Agent API key infrastructure, allowlist middleware
- Phase 6 (new): Audit log table, middleware, query capabilities
- Phase 7 (new): Rate limiting, versioning strategy, agent onboarding process
- Phase 8 (new): Migration of 4 existing scripts to endpoint-based agent flows
- Anti-Hallucination Playbook prompt work for AP Specialist becomes lower priority — structural fix supersedes prompt discipline

## Alternatives Considered

### Pattern A — Scripts Only (Status Quo, Hardened)

Reject. Even with hardening (Option A write guard, parameterized constants, dry-run modes), scripts retain fundamental problems: Bash tool access gives unbounded blast radius, no schema validation prevents hallucinated operations, no audit trail beyond ad-hoc logging, and every operation needs duplicate implementation if a human-facing surface is added later.

### Pattern B Lite

Reject. Without per-agent permission allowlists and comprehensive audit logging, Pattern B's safety benefits are largely theoretical. "API key access to every endpoint" has the same effective blast radius as Bash. The implementation savings (~50 hours) are not worth losing the structural safety properties.

### Pattern C — Hybrid (Scripts for Internal, Endpoints for External)

Reject. The hybrid's maximum damage scenario inherits Pattern A's weaknesses for script-side operations. Endpoints add safety only where they cover; scripts remain vulnerable. The pattern creates dual-implementation drift risk and dual-permission-model operational complexity without resolving Pattern A's worst-case failure mode.

## References

- Strategic Plan (`docs/LEDGERIX-PRO-STRATEGIC-PLAN.md`) — business framing for 50-client lifestyle scale
- API Specification (`docs/PHASE-4-ACCOUNTING-API-SPEC.md`) — endpoint contracts (in progress)
- May 11-17 hallucination incident — root cause analysis surfaced in conversation, see commit `4638877a` for safety code response
