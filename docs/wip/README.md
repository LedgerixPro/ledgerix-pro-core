# WIP — Work-In-Progress Documents

This directory holds **active, multi-session work** that doesn't yet have a permanent home in an ADR, the EA, or the Brief. It exists because Claude has no persistent memory across sessions, and substantial architectural work spans multiple days. Without WIP docs, every new session starts with incomplete context and risks re-litigating decisions, missing blockers, or undoing in-flight progress.

## When to create a WIP doc

Create one whenever any of the following are true:
- A piece of work will span more than one session
- The work has architecture decisions that need to persist across sessions
- The work has blockers, deferred items, or "NOT doing" rejections that future-me must respect
- The work is too in-flight to be captured in an ADR (ADRs document settled decisions; WIP docs document the path of arriving at them)

## When NOT to create a WIP doc

- Single-session work that ships completely within one session — commit messages + tracker + ADRs are enough
- Work where the design is already locked in an ADR and the remaining work is purely implementation — track via PHASE-N-PROGRESS.md instead
- Throwaway exploration or scratch work — don't pollute docs/wip/ with this

## File naming

Format: `<phase-or-feature>-<short-description>.md`

Examples:
- `phase-4c-5-write-endpoints-and-admin-api.md`
- `charter-status-storage-decision.md`
- `payment-endpoint-safety-design.md`

Lowercase, hyphenated, descriptive enough to identify from filename alone.

## Required structure

Every WIP doc must include the following sections, in this order:

```markdown
# WIP: <Title>

**Status:** in_progress | blocked | paused | ready_to_merge_to_adr
**Started:** <ISO date>
**Last updated:** <ISO date> at end of <session>
**Owner:** Scott Hansbury
**Related ADRs:** <links to ADRs that govern this work>
**Estimated remaining work:** <honest time estimate; update as you learn>

## Context

Why this work exists. What problem it solves. What would happen if it didn't get done.

## Architecture Decisions Made

Locked decisions that will not be reopened mid-session. Each entry should include the reasoning briefly. These are commitments, not options.

Example format:
- **Decision A**: <what was decided>. Reasoning: <why>. Locked: <session/date>.

## Architecture Decisions Pending

Real design questions that still need answers before the work can proceed cleanly. These get resolved either via discussion-in-session or by punting them to a separate decision doc.

## Work Done (cumulative)

What's shipped via commits. Each entry should reference the commit hash and a one-line summary. Read at the start of every session to know the current state.

Example:
- `abc1234` — Migration 0067: write_thresholds_seeds table
- `def5678` — Admin endpoint POST /api/admin/pricing/seed

## Next Steps (in order)

Specific next-session work. Concrete enough that future-me can pick up without re-deriving context. NOT a vague roadmap.

## Blockers

What's preventing progress right now. Each blocker needs:
- What the blocker is
- What unblocks it
- Who/what is responsible for resolving

## NOT Doing (deliberately)

Things considered and rejected with reasoning. Critical for preventing re-litigation: future-me sees this and doesn't waste a session re-proposing an already-rejected idea.

Example format:
- **REJECTED: Approach X**. Considered <date>. Reason: <why rejected>. Don't re-propose without new information.

## Session Log

Append-only running log of what happened each session. Format:

### Session N — <ISO date>

- What was attempted
- What was decided (link to "Architecture Decisions Made" updates above)
- What was shipped (link to "Work Done" updates above)
- What was learned (especially failure modes / discoveries)
- What's the state at session end (so future-me has a snapshot)

The Session Log is critical for cross-session continuity. It's how future-me reconstructs the path of decisions, not just the destination.
```

## Discipline rules

These are non-negotiable for the pattern to work:

1. **Update at every session end.** The WIP doc must reflect the actual state of work before the session closes. No exceptions.

2. **Read the WIP doc at session start.** When resuming work, the FIRST thing to do is read the relevant WIP doc(s). Decisions in "Architecture Decisions Made" are locked; don't reopen. Items in "NOT Doing" are rejected; don't re-propose.

3. **Decisions move from Pending to Made.** As architecture decisions get resolved in-session, update the doc to move them. Don't leave decisions ambiguous across sessions.

4. **Session Log is append-only.** Never edit previous Session Log entries. They're historical record. New entries go at the bottom.

5. **Honest status reporting.** "Status: in_progress" but no commits in three sessions = the doc is lying. Update to "paused" or "blocked" honestly.

## When to remove a WIP doc

Remove (or move) when the work completes:

- **All decisions locked + work shipped + tests passing** → Move the Architecture Decisions to an ADR, summarize the result in the relevant PHASE-N-PROGRESS.md, delete the WIP doc.
- **Work abandoned** → Don't delete silently. Add a final Session Log entry explaining why it was abandoned and what was learned. Then move to `docs/wip/archived/` rather than deleting outright.

## Relationship to other docs

- **ADR documents** are for settled architectural decisions. WIP docs are for arriving-at-the-decisions work.
- **PHASE-N-PROGRESS.md** tracks shipping status of well-scoped work. WIP docs track multi-session architectural exploration.
- **EA + Brief** are end-state authoritative docs, updated only after WIP work merges to ADR or ships.
- **Git commit messages** are immutable historical record. WIP docs reference them but never overwrite them.

If a WIP doc and another doc disagree, the WIP doc is the truth FOR ACTIVE WORK. The other docs reflect the past state.
