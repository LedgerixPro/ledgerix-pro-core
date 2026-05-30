<!-- Overwritten at every session close. Single source of truth for session start. Paste `cat docs/SESSION-HANDOFF.md` as the first message of a new session. -->

SESSION HANDOFF — 2026-05-29
HEAD: b798dfd6   tree: clean
Phase: Phase 6 (Audit & Retention) — software half COMPLETE; remaining sub-phases: 6c-infra (operational), 6b (integrity), deferred backstop-middleware + fidelity-standardization
Last shipped: 5b retrieval — retrieveAuditTrail (live/archived/none) + board-gated GET /companies/:companyId/audit (b52a2941); session-end doc marker (b798dfd6)
NEXT ACTION: Scott picks at session start from 4 options; standing recommendation = (1) scope 6c-infra as an actionable checklist (PAPERCLIP_ARCHIVE_MASTER_KEY generation/custody/escrow/no-rotate, Railway durable bucket choice, env wiring)
Test baseline: 2167/2169 pass via `pnpm test` (full monorepo, 334 files; 1 skipped). Known-red: cli/worktree.test.ts (pre-existing DB-restore failure, NOT Phase 6, NOT a regression). ~3 server tests (cli-auth-routes, heartbeat-dependency-scheduling, issue-closed-workspace-routes) flake under parallel load.
Open decisions: which next-direction option to open next session with — (1) 6c-infra checklist / (2) 6b integrity code arc / (3) deferred cleanup / (4) Phase 6 ADR + closeout
