# Claude — Session Startup Guide

This file is the FIRST thing Claude should read at the start of every session working on this codebase. It points at the authoritative documents and the in-flight work.

## Authoritative documents (read in this order)

1. **`docs/LedgerixPro-Claude-Project-Brief-v1.3.docx`** — condensed system overview. Read first for fast orientation.
2. **`docs/LedgerixPro-Enterprise-Architecture-v3.3.docx`** — full architecture. Read for detail on any specific subsystem.
3. **`docs/adr/`** — Architecture Decision Records. Settled decisions. Each ADR is locked and should not be reopened without explicit reason.
4. **`docs/PHASE-4-PROGRESS.md`** — current phase tracker. Status of Phase 4 work.

## In-flight work (CHECK BEFORE STARTING ANY WORK)

**`docs/wip/`** — Work-in-progress documents for multi-session architectural work. If this directory contains any files (besides README.md), read them BEFORE starting new work. They capture:
- Architecture decisions already locked (do not reopen)
- Architecture decisions still pending (current focus)
- Rejected options (do not re-propose)
- Session-by-session progress log

See `docs/wip/README.md` for the WIP doc convention.

## Critical operating principles

These are non-negotiable, established across sessions:

1. **Trust tenet (May 24, 2026):** No real clients onboarded — including Ledgerix Pro's own books — until the system is correct, trustworthy, and dialed in for security and safety of client funds. No partial-spec compliance on safety-critical write endpoints. Time is reference for planning, not a gate for go/no-go decisions.

2. **Verify before assuming.** Always check assumptions before acting. Grep for callers before claiming a function is unused. View existing imports before claiming code compiles. Read the authoritative document before quoting numbers from session memory. Skipping these checks has caused real errors.

3. **Session-end documentation discipline.** Every session ends with EA + Brief + all relevant trackers + WIP docs reflecting what was committed that session. No exceptions. "Documents of truth" must actually be true at session close, or future sessions start with wrong information.

4. **Locked decisions stay locked.** Once an architectural decision is committed (in an ADR, a WIP doc's "Decisions Made" section, or explicit acknowledgment in a conversation), it doesn't get reopened for refinement. Implementation details discovered during execution are handled during execution, not by reopening the decision.

5. **WIP docs are the truth for active work.** If a WIP doc and another doc disagree about an in-flight piece of work, the WIP doc is correct. Other docs reflect the past or end state.

## Coding workflow

- Codebase: `/Users/scotthansbury/Projects/ledgerix-pro-core` (local) and `github.com/LedgerixPro/ledgerix-pro-core` (private)
- Scott uses Claude Code via terminal for all code changes
- All commands should be ready-to-paste with full context
- Railway env vars: NEVER wrap values in quotes (KEY=value, not KEY="value")
- Migration workflow: edit schema TS → `pnpm generate` → drizzle-kit auto-creates SQL + snapshot
- Test discipline: targeted vitest runs (`pnpm exec vitest run <file>`) for what changed; full suite has known flakiness in unrelated workspace-runtime tests due to parallel-run resource contention

## File ownership

- **Scott edits directly:** the two Word docs in `docs/` (EA, Brief)
- **Claude edits (via scripts):** all `.md` files in repo, all source code, all tests
- **Never edit:** files under `/mnt/skills/` (read-only system skills)

## What to do at session start

1. Read `docs/LedgerixPro-Claude-Project-Brief-v1.3.docx` for orientation
2. Check `docs/wip/` for active multi-session work
3. Check `docs/PHASE-4-PROGRESS.md` for current phase status
4. If WIP docs exist, read them BEFORE proposing any architectural changes
5. Verify locked decisions stay locked; verify rejected options stay rejected
