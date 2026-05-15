# Anti-Hallucination Playbook

## 1. Purpose

This playbook is the canonical spec for keeping Ledgerix Pro agents from inventing data. Every agent AGENTS.md going forward — both new agents and revisions to existing ones — must be authored or amended to satisfy the four patterns below. The motivating incident: on 2026-05-15, the AP Specialist agent generated five fabricated overdue bills (vendor names, dollar amounts, due dates) and emailed them to a client whose Xero ledger contains zero bills. The agent's data fetch had silently failed, but its AGENTS.md prompt provided no path for "I have no data" — only paths for "I have data and must produce output" — so the LLM filled the templated entity slots with plausible-sounding values rather than refusing.

## 2. The failure mode

LLMs do not refuse output when a prompt insists on output. When an agent's instructions contain a template like `Subject: "Overdue bill — [VendorName] $[Amount]"` and the agent is instructed to send that email, the LLM treats `[VendorName]` and `[Amount]` as fill-in-the-blank prompts. If real data exists, the slots get real values. If real data does not exist, the slots still get values — they are plausible inventions drawn from the model's training corpus (which is why the fake AP bills had realistic vendors like Norton Lumber and PG&E rather than gibberish). An instruction line that says "do not hallucinate" near the bottom of the prompt does not override the structural pressure of a templated output that demands to be filled. The cure is not stronger warnings; the cure is to design the prompt so that producing fabricated output is no longer the path of least resistance. The four patterns below collectively redesign the prompt so that the no-data path is as concrete and well-defined as the data-present path, eliminating the LLM's incentive to invent.

## 3. Pattern 1 — Verify Before Output ("Preconditions")

Every agent AGENTS.md must begin with a Preconditions block that gates all output behind explicit verification of the data fetch. The standard text to include verbatim at the top of every AGENTS.md, immediately after the role-description paragraph and before any procedure step:

```
## Preconditions — Do Not Skip

Before performing any output action (email, SMS, GHL update, issue creation, file write):

1. The data fetch tool call MUST have succeeded (no error, no timeout).
2. The data fetch MUST have returned at least one record matching your filter criteria.
3. Every domain entity referenced in your output (vendor name, amount, date, person name, account ID, etc.) MUST trace back to a specific field in a specific record returned by step 1.

If ANY precondition fails, you produce no output, set issue Status: blocked with reason, and exit immediately.

You NEVER invent vendor names, amounts, dates, customer names, or any other domain entity.
```

This block is the single most important addition. It is placed at the top of the file so the LLM reads it before any procedure step. It is phrased as a hard rule with no exceptions and explicit consequences (status: blocked, exit). The "you never invent" line is the final fallback for cases the preconditions did not anticipate.

## 4. Pattern 2 — Conditional Templates, Not Entity-Slot Templates

The proximate mechanism of the AP Specialist hallucination was the email body template at lines 32–40 of `agents/ap-specialist/AGENTS.md`:

```
Subject: "Upcoming bill due soon — [VendorName] $[Amount]"
Body:
"Hi [FirstName], just a heads up — you have a bill due in [N] days:
Vendor: [VendorName]
Amount: $[Amount]
Due: [DueDate]
...
— Scott Hansbury, Ledgerix Pro"
```

This template demands four domain entities (`[VendorName]`, `[Amount]`, `[N]`, `[DueDate]`) per email. When the underlying `getBills` call returns nothing, those slots have no real values — but the instruction "send email to client" still applies, so the LLM produces plausible values to satisfy the template. The structural problem is that the template is unconditional. The fix is to put the template inside an explicit `IF data_exists` clause and provide a complementary `ELSE` branch that defines exactly what to do when the data is absent.

**Before** (the AP Specialist pattern that produced the fake bills):

```
For each overdue bill, send email:
Subject: "Overdue bill needs attention — [VendorName] $[Amount]"
```

**After** (the corrected pattern):

```
IF overdue_bills.count > 0:
  For each bill in overdue_bills (verified non-empty from the getBills result):
    Send email:
      Subject: "Overdue bill needs attention — {bill.vendor.name} ${bill.amount}"
ELSE:
  Send no email.
  Log "No overdue bills found for {clientName} — no email sent."
```

Two specific authoring rules follow from this:

**Rule 2a — bracket syntax.** Use `{variable.field}` for real variable references that the agent must read from a tool call's actual return value. Do not use `[square brackets]` anywhere in templates. The LLM treats `[square brackets]` as fill-in-the-blank prompts — a learned association from training data containing form templates. Curly braces with a dotted path are unambiguous: "this is a variable lookup against a real object, not a slot to invent."

**Rule 2b — every template lives inside a conditional.** If a template references any domain entity (vendor, amount, date, customer name, invoice number, account ID), the template must be inside an `IF entity_source.count > 0:` clause. Aggregate-only templates that contain nothing but numbers (`Auto-categorization rate: {rate}%`) can remain unconditional because their natural zero rendering is honest: `Auto-categorization rate: 0%` is correct and not fabricated. The Quality Control agent's weekly report template at lines 142–170 of `agents/quality-control/AGENTS.md` is the model for this — numeric aggregates throughout, with the alerts section explicitly defining the empty case (`"None — all checks passed"`).

## 5. Pattern 3 — Vocabulary for "No Work to Do"

A run that fetched data successfully and found zero records is a successful run, not a failed one. Every agent must have explicit language for this state in both its runMetrics and its closing comment, so the LLM has a clear shape to fill rather than feeling pressure to produce work where none exists.

Every agent's `runMetrics` JSON must include these four fields in addition to any agent-specific metrics:

```
{
  "dataFetchSucceeded": true | false,
  "recordsFound": <integer, zero is valid>,
  "outputsProduced": <integer, zero is valid>,
  "reasonNoOutput": <string when outputsProduced is 0, otherwise null>
}
```

The closing comment template for the zero-output case, included alongside the existing agent-specific closing templates:

> "Run complete. Data fetch succeeded. {recordsFound} records found. 0 outputs produced. Reason: {reasonNoOutput}."

For the AP Specialist daily scan, an honest no-work run would have produced exactly this comment: `"Run complete. Data fetch succeeded. 0 records found. 0 outputs produced. Reason: No open bills in Xero for any client-active contact."` Status remains `done`. This is a normal, expected, successful outcome — not blocked, not failed, not partial. The agent ran, looked, found nothing, and reported nothing. When the prompt explicitly defines this shape, the LLM has a complete and concrete place to land instead of being pulled toward fabricating output to satisfy the templated procedure steps.

## 6. Pattern 4 — Tools Must Be Real

The AP Specialist's AGENTS.md Step 2 instructs the agent to call `qbo.getBills(db, PAPERCLIP_COMPANY_ID, contact.id)` and `xero.getBills(db, PAPERCLIP_COMPANY_ID, contact.id)`. These are TypeScript function signatures from `server/src/services/accounting/index.ts`. They are not Paperclip skill tool calls. The agent has no JavaScript runtime — it can only invoke tools registered with the Paperclip skill at runtime. When the agent's instructions reference a tool that does not exist as a runtime capability, two failures cascade in sequence: first, the agent spends turns attempting to find or call the non-existent capability (this is what likely consumed the 40-turn budget on 2026-05-15); second, when the agent fails to complete the data fetch and runs out of turns, it still attempts to produce the remaining output steps in its prompt — which is when the hallucinated bills appear.

The rule is direct: **every tool reference in an AGENTS.md must map to an actual Paperclip skill the agent can call at runtime.** If an agent needs accounting data, the AGENTS.md must reference the Paperclip skill name (or HTTP endpoint, or however the agent actually obtains data), not the underlying TypeScript symbol. If the necessary tool does not exist yet, the AGENTS.md must not be written — the tool must be built first.

A verification step is required before any agent is enabled: walk through the AGENTS.md and confirm that every tool call mentioned has a corresponding runtime capability the agent can invoke. This verification is one-time per agent and is the responsibility of whoever authors or edits the AGENTS.md.

## 7. Application Checklist

When editing any existing AGENTS.md or authoring a new one, complete each step in order. Do not skip steps.

1. Add the Preconditions block from Pattern 1 at the top of the file, immediately after the role-description paragraph.
2. Find every `[EntitySlot]` template in the file. Replace each with a `{variable.field}` reference, and wrap the surrounding template in an `IF entity_source.count > 0:` conditional with an explicit `ELSE` branch describing the no-data behavior.
3. Add the four `runMetrics` fields from Pattern 3 (`dataFetchSucceeded`, `recordsFound`, `outputsProduced`, `reasonNoOutput`) to every `runMetrics` block in the agent's procedures. Add the no-work closing-comment template alongside any existing closing templates.
4. For every tool reference in the file, verify it maps to a real Paperclip skill the agent can invoke at runtime. Replace TypeScript function references with the actual tool names the agent has access to.
5. Remove any example outputs that contain populated entity values (real-looking vendor names, dollar amounts, dates, customer names). These are echo traps — the LLM may copy them verbatim into real output. Examples should use abstract placeholders only (`{variable.field}` notation), never populated samples.
6. Add an explicit "if the data fetch returns empty, do not produce output" instruction inside every procedure step that involves output, even if the Preconditions block at the top of the file already says the same thing. Redundancy here is intentional — the LLM may attend to a local instruction near the output action more strongly than a global one at the top.
7. Test the revised agent against a known-empty data set (a contact with no bills, a day with no Ledger Specialist runs, etc.) and confirm it produces no output and writes the no-work runMetrics. Until this test passes, the AGENTS.md is not ready for production.

## 8. What This Playbook Does Not Fix

This playbook prevents fabrication of data when no data exists. It does not prevent misinterpretation of real data. An agent that successfully fetches a real bill and categorizes it incorrectly, escalates to the wrong recipient, or applies the wrong rule is doing something different — making a wrong decision on present data, not inventing absent data. Different mitigations apply: structured decision rules, KB constraints, HITL escalation thresholds, agent-pair review.

This playbook also does not eliminate the failure mode entirely — even with all four patterns in place, an LLM may still hallucinate under sufficient prompt pressure or in edge cases. Defense-in-depth is required. The planned hallucination detector (Phase 5) is the next-layer mitigation: a separate agent or check that reads each agent's outputs and flags claims that do not trace to a verifiable data source. This playbook reduces the rate of hallucinations meaningfully but does not drive it to zero, and no AGENTS.md change is a substitute for catching the residual cases at runtime.
