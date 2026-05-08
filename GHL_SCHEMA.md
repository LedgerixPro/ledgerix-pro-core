# GHL Custom Field Schema

Custom fields on the GHL Contact object for the Ledgerix Pro sub-account (Location ID: GhnRONQQVJiCKsdWoQFc). These fields are written and read by Paperclip agents via the GHL API v2.

All fields live on the Contact object. API keys use dot notation (contact.field_name). Merge field syntax wraps the key in double curly braces.

---

## Contact Custom Fields

| # | Display Name | API Key | Internal ID | Merge Field | Type | Allowed Values |
|---|---|---|---|---|---|---|
| 1 | Client Type | contact.client_type | Cf539co3LHJrm6wLAJQJ | {{ contact.client_type }} | Dropdown (Single) | Trades - HVAC, Trades - Plumbing, Trades - Electrical, Trades - Roofing, Trades - Flooring, Agency, Small Business |
| 2 | Service Tier | contact.service_tier | Dh5rwdlahz6a37BAQDIs | {{ contact.service_tier }} | Dropdown (Single) | The Foundation, The Growth Engine, The Scale-Up |
| 3 | ICP Status | contact.icp_status | r2elR53Q8VdI4MpAA0It | {{ contact.icp_status }} | Dropdown (Single) | Qualified, ICP Fail, Unresponsive, Future, DNC, Nurture Active, Nurture Archive |
| 4 | Signal Confidence Score | contact.signal_confidence_score | gYdXRb56AUarXkgfz0jY | {{ contact.signal_confidence_score }} | Number | 1–10 integer |
| 5 | Diagnostic Amount | contact.diagnostic_amount | kXo397ntvWymY6OP1ne4 | {{ contact.diagnostic_amount }} | Monetary | USD dollar amount from completed diagnostic survey |
| 6 | NPS Score | contact.nps_score | Dde0m2983zNBRgrCqjvU | {{ contact.nps_score }} | Number | 1–10 integer |
| 7 | Ledgerix Workspace ID | contact.ledgerix_workspace_id | vmAT4OjG10QboXA2Jqjs | {{ contact.ledgerix_workspace_id }} | Text | UUID — links GHL contact to Paperclip company workspace. Auto-populated by Paperclip on contact creation. |
| 8 | Nurture Month | contact.nurture_month | sMQegZrU2giDsyaNKnjt | {{ contact.nurture_month }} | Number | 1–6 integer (current month in 6-month lost-prospect nurture sequence) |

---

## Field Usage Notes

**contact.client_type** — Set by the Lead Qualifier agent after ICP evaluation. Drives agent routing logic and service tier recommendations. Used in workflow conditional filters.

**contact.service_tier** — Set when a lead is qualified or when a client upgrades/downgrades. Values must match Ledgerix brand names exactly (with "The" prefix). Used in proposal generation and CS agent handoff.

**contact.icp_status** — Primary lifecycle state for lead qualification. Managed by the Lead Qualifier agent. Qualified = ready for SDR handoff. DNC = do not contact, suppress from all outreach. Nurture Active = in long-term nurture sequence. Nurture Archive = cold, removed from active sequences.

**contact.signal_confidence_score** — AI-generated score (1–10) representing confidence that this contact matches the Ideal Customer Profile. Produced by the Lead Qualifier agent based on enrichment signals. Feeds SDR pitch prioritization.

**contact.diagnostic_amount** — Dollar amount surfaced from a completed diagnostic survey. Represents the estimated bookkeeping complexity or current spend. Fed directly into the SDR pitch script to personalize value framing.

**contact.nps_score** — Net Promoter Score collected post-engagement. Written by the CS/Client Success agent after NPS survey completion. Used for churn risk detection and referral identification.

**contact.ledgerix_workspace_id** — Critical linking field. Written by Paperclip on first contact sync. Enables any GHL-side event to be directly associated with the correct Paperclip company workspace without re-deriving the mapping. Must never be manually edited once set.

---

## Agent Write Permissions

| Field | Agent(s) That May Write |
|---|---|
| contact.client_type | Lead Qualifier |
| contact.service_tier | Lead Qualifier, SDR (when diagnostic_amount is set), Account Executive, CS Agent |
| contact.icp_status | Lead Qualifier |
| contact.signal_confidence_score | Lead Qualifier |
| contact.diagnostic_amount | Onboarding Agent (from survey results) |
| contact.nps_score | CS / Client Success Agent |
| contact.ledgerix_workspace_id | Onboarding Agent (on first sync, write-once) |

---

## GHL API Reference

To read or write these fields via GHL API v2:

- **Read a contact:** GET /contacts/{contactId}
- **Update a contact field:** PUT /contacts/{contactId} with body { "customFields": [{ "id": "field_key", "field_value": "value" }] }
- **Base URL:** https://services.leadconnectorhq.com
- **Auth:** Bearer token (OAuth 2.0 — see Section 7 of RESET.md for rotation procedure)

---

## API Write/Read Asymmetry

GHL uses different property names for custom field values depending on direction:

| Operation | Endpoint | Custom field shape |
|---|---|---|
| Write | PUT /contacts/{id} | { id: "fieldId", field_value: "value" } |
| Read | GET /contacts/{id} | { id: "fieldId", value: "value" } |

This is handled automatically by the Paperclip GHL service module:
- `server/src/services/ghl/contacts.ts` uses `GHLCustomFieldWrite` internally for PUT requests
- `GHLContact.customFields` is typed as `GHLCustomFieldRead[]` for GET responses
- Use `getFieldValue(contact, 'field_key')` to read any custom field — never access `customFields` array directly in agent code

---

## Pipeline IDs

### Ledgerix Pro Sales — dtgrQV0u9DB5EmxJGY9K
| Stage | ID |
|---|---|
| New Lead | 19eb8ca2-3ac0-409a-aa64-8a39d99e27ba |
| Contacted | 4a05c362-4edf-4bb5-a7d2-49f60dd3a115 |
| Qualified | 63f49240-5b59-4131-8674-abfabe3c4f55 |
| Proposal Sent | 45cb666b-ce27-4235-be54-c047f4b2e35a |
| Active Client | 033a970f-3f6a-41bc-ada2-b2481621e119 |
| Lost | 0efd31ca-9175-462f-9957-66adb82efb54 |

### Ledgerix Pro Clients — EOq8U8BCqRMX9kM5g2qS
| Stage | ID |
|---|---|
| Onboarding | 57496295-d824-4b7b-8f30-c849e6c42e14 |
| Active | d0aaa601-140f-47dc-9229-74b2feb82c35 |
| At Risk | 52f6577b-3520-4965-9837-0d7d9531f85f |
| Churned | d5fe65ab-3267-4e1d-b475-2b8120398e54 |

### Ledgerix Pro Churn — A4SSmXmDnwPKGfxKcvut
| Stage | ID |
|---|---|
| At Risk | 0f7ad6c4-c686-4c35-afa4-d4aca905e35a |
| Paused | 93460bfc-81b1-4621-8217-709dabe24ef3 |
| Churned | d5aa0f6d-a29e-4251-b060-f54eb4cbda8d |
| Reactivated | af7d0116-27b0-4bed-adae-7f1da254848f |
