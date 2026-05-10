# Local Dev Reset Runbook

Procedures for resetting and restoring the local Ledgerix Pro dev environment.

---

## 1. Reset the embedded PostgreSQL database

Use this when the database is corrupted, migrations are broken, or you need a clean slate.

```sh
rm -rf data/pglite
```

This deletes the embedded Postgres data directory. The next `pnpm dev` start will
re-initialise Postgres from scratch and auto-apply all migrations.

---

## 2. Re-seed the Ledgerix Pro company row

After a database reset the `companies` table is empty. Re-insert the Ledgerix Pro
row with its fixed UUID so the workspace registry and any FK-dependent tables work correctly.

```sh
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
  -c "INSERT INTO companies (id, name, status, issue_prefix, issue_counter, budget_monthly_cents, spent_monthly_cents) \
      VALUES ('f60117de-1131-433c-934f-3fe88bfaa163', 'Ledgerix Pro', 'active', 'LED', 1, 0, 0) \
      ON CONFLICT (id) DO NOTHING;"
```

**Run this after the server is already up** — the embedded Postgres process must be running
before psql can connect (port 54329 is only open while `pnpm dev` is active).

`ON CONFLICT DO NOTHING` makes the command safe to run multiple times.

---

## 3. Install psql if it is not found

psql ships with `libpq`. Install via Homebrew:

```sh
brew install libpq
```

Then add it to your PATH (Homebrew does not link libpq automatically):

```sh
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Verify:

```sh
psql --version
```

---

## 4. Re-seed the 24-agent workforce

After the company row exists, recreate all 24 agents with correct names, titles, and
reporting structure. The script is idempotent — safe to run multiple times.

```sh
node_modules/.pnpm/node_modules/.bin/tsx scripts/seed-agents.ts
```

**Run this after the server is already up** and the company row has been inserted.

---

## 5. Start the dev server

From the project root:

```sh
pnpm dev
```

Server starts at **http://localhost:3100**. Embedded Postgres starts automatically on
port 54329. Migrations are applied on first boot.

---

## 6. Cloudflare Tunnel (production domain)

The production domain api.ledgerixpro.com is served via Cloudflare Tunnel.
Tunnel ID: cdcb2ef5-d434-46dc-894b-00dcc125b475
Config: ~/.cloudflared/config.yml

The tunnel runs as a macOS launch agent and starts automatically at login.
No manual start needed in normal operation.

To check tunnel status:
```sh
cloudflared tunnel info ledgerix-pro
```

To restart the tunnel service if needed:
```sh
launchctl stop com.cloudflare.cloudflared
launchctl start com.cloudflare.cloudflared
```

To run manually for debugging:
```sh
cloudflared tunnel run ledgerix-pro
```

GHL webhook endpoint (permanent, never changes):
```
https://api.ledgerixpro.com/api/webhooks/ghl
```

Paperclip hostname allowlist entry: api.ledgerixpro.com
Already added — survives server restarts, does not need to be re-added.

ngrok is no longer used. Do not update GHL workflows with ngrok URLs.

---

## 7. GHL webhook auth & secret rotation

Auth uses a shared secret (`X-Ledgerix-Secret` header) checked against `GHL_WEBHOOK_SECRET` in `.env`. HMAC verification via `x-webhook-signature` is preserved as a fallback for future signed sources but is not used by GHL's native Webhook action.

The secret must match exactly in two places:
- `.env` → `GHL_WEBHOOK_SECRET=...`
- Every GHL workflow's Webhook action → Headers → `X-Ledgerix-Secret`

**To rotate the secret:**

```sh
# 1. Generate a new 64-char hex secret
openssl rand -hex 32

# 2. Update .env with the new value (replace the existing GHL_WEBHOOK_SECRET line)

# 3. Restart pnpm dev so the new env is loaded
```

Then, in GHL UI for every workflow that hits /api/webhooks/ghl:
1. Sub-account → Automation → open workflow → click Webhook action
2. Headers → `X-Ledgerix-Secret` → paste new value → Save action
3. Save and Publish the workflow

Test by creating a contact (or whatever event the workflow listens to) and confirming a 200 in the Paperclip server logs or GHL workflow Execution Logs tab.

---

## 8. Adding a new GHL event workflow

Pattern is the same for every event type. Three things change per workflow: the trigger, the `event` value in custom data, and the dispatcher route entry.

**In GHL** (Sub-account → Automation → + Create Workflow):
1. Trigger: pick the GHL event (e.g. Contact Created, Invoice Paid, Opportunity Status Changed)
2. Action: + Add Action → Webhook (the free one, not Custom Webhook)
3. Configure:
   - Method: POST
   - URL: `https://<your-ngrok-url>/api/webhooks/ghl`
   - Custom Data:
     - `event`: a stable identifier (e.g. `contact.created`, `invoice.paid`, `opportunity.won`)
     - `locationId`: `GhnRONQQVJiCKsdWoQFc`
     - `source`: `ghl`
   - Headers:
     - `Content-Type`: `application/json`
     - `X-Ledgerix-Secret`: value from .env
4. Save action → Save and Publish workflow

**In code** (server/src/services/dispatcher.ts):
- Add a routing table entry mapping the new `event` value to a target agent and priority
- Without this, the handler will return 200 but the dispatch will be `routed: false, targetAgent: null`

Naming convention for workflows: `GHL: <Event Name> → Paperclip` (e.g. `GHL: Invoice Paid → Paperclip`). Each event type = its own workflow; do not multiplex.

---

## 9. Common failure modes

Quick reference for the most common webhook errors and their fixes.

| Symptom | Cause | Fix |
|---|---|---|
| `403 Hostname not allowed` | ngrok hostname not in Paperclip allowlist | Run `pnpm paperclipai allowed-hostname <hostname>` and restart |
| `401 Missing x-webhook-signature header or x-ledgerix-secret header` | Neither auth header sent | Confirm GHL workflow has `X-Ledgerix-Secret` in Headers and is Published |
| `401 Invalid shared secret` | Header sent but value doesn't match `.env` | Re-paste secret from `.env` into GHL workflow header, save, republish |
| `400 Payload missing locationId` | Custom data missing `locationId` field | Add `locationId: GhnRONQQVJiCKsdWoQFc` to GHL workflow Custom Data |
| `200 OK` but `routed: false`, `targetAgent: null` in logs | Dispatcher has no route for the event type | Add a routing entry in server/src/services/dispatcher.ts for the event value |
| Request never reaches Paperclip | ngrok URL changed since GHL was configured, or ngrok is down | Check http://localhost:4040 for active tunnel; update GHL workflow URL if changed |

Useful diagnostic tools:
- `http://localhost:4040` — ngrok request inspector (live request/response, including headers and body)
- Paperclip terminal logs — look for `GHL webhook received` and `GHL dispatch routing decision` lines
- GHL workflow → Execution Logs tab — shows what GHL sent and what response it got

---

## 10. GHL custom field schema

See GHL_SCHEMA.md in the project root for the full schema, API keys, merge field syntax, allowed values, and agent write permissions for all seven Ledgerix Pro custom fields on the GHL Contact object.

---

## 11. Restore the Onboarding agent configuration

After a DB reset and agent re-seed, the Onboarding agent's adapter_type and adapter_config are wiped back to defaults. Restore with:

```sql
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/onboarding/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }'
WHERE name = 'Onboarding'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/onboarding/AGENTS.md

This file is version-controlled and does not need to be restored after a DB reset — only the DB record needs updating.

---

## 12. Restore the SDR agent configuration

After a DB reset and agent re-seed, restore the SDR agent adapter config:

```sql
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-opus-4-7\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/sdr/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }'
WHERE name = 'SDR'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

**Outreach persona:** Laura, Outreach Manager | Ledgerix Pro
**Sending address:** laura@ledgerixpro.com
**Instructions file:** agents/sdr/AGENTS.md (version-controlled, does not need restoration after DB reset)

---

## 13. Restore the Client Success Manager agent configuration

After a DB reset and agent re-seed, restore the CSM agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/csm/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 25,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }'
WHERE name = 'Client Success Manager'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/csm/AGENTS.md

---

## 14. Restore the Client Health Monitor agent configuration

After a DB reset and agent re-seed, restore the Client Health Monitor agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/client-health/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 30,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Client Health Monitor'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/client-health/AGENTS.md

---

## 15. Restore the AR Specialist agent configuration

After a DB reset and agent re-seed, restore the AR Specialist agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ar-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'AR Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/ar-specialist/AGENTS.md

---

## 16. Restore the Sentinel agent configuration

After a DB reset and agent re-seed, restore the Sentinel agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/sentinel/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Sentinel'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/sentinel/AGENTS.md

The daily 6am Arizona cron routine that drives this agent must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## 17. Restore the Ledger Specialist agent configuration

After a DB reset and agent re-seed, restore the Ledger Specialist agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ledger-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 50,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Ledger Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/ledger-specialist/AGENTS.md

---

## 18. Restore the Reconciliation agent configuration

After a DB reset and agent re-seed, restore the Reconciliation agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reconciliation/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 50,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Reconciliation Agent'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/reconciliation/AGENTS.md

Note: the agent's name in DB is `Reconciliation Agent` (not `Reconciliation`) — must match the dispatcher routing entry for `reconciliation_anomaly`.

---

## 19. Restore the Senior Bookkeeper agent configuration

After a DB reset and agent re-seed, restore the Senior Bookkeeper agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-opus-4-7\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/senior-bookkeeper/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Senior Bookkeeper'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/senior-bookkeeper/AGENTS.md

Note: Senior Bookkeeper uses `claude-opus-4-7` (not sonnet) — final-decision agent needs the strongest model.

---

## 20. Restore the Knowledge Base Manager agent configuration

After a DB reset and agent re-seed, restore the Knowledge Base Manager agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/knowledge-base-manager/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 30,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Knowledge Base Manager'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/knowledge-base-manager/AGENTS.md

The KB itself lives in a Paperclip issue per client (status: backlog, no assignee), titled `KB — {contactName} — {clientCompanyId}`. The KB issues survive DB resets only if the database is preserved — a full `rm -rf data/pglite` will wipe accumulated rules.

---

## 21. Restore the Reactivation agent configuration

After a DB reset and agent re-seed, restore the Reactivation agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reactivation/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": false}'
WHERE name = 'Reactivation'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/reactivation/AGENTS.md

The monthly cron routine (1st of month 9am Arizona) that drives this agent must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## 22. Restore the Billing & Invoicing agent configuration

After a DB reset and agent re-seed, restore the Billing & Invoicing agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/billing-invoicing/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": false}'
WHERE name = 'Billing & Invoicing'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/billing-invoicing/AGENTS.md

The monthly cron routine (1st of month 8am Arizona) that drives this agent must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## 23. Restore the AP Specialist agent configuration

After a DB reset and agent re-seed, restore the AP Specialist agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ap-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}',
  title = 'Accounts Payable Specialist'
WHERE name = 'AP Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/ap-specialist/AGENTS.md

Two cron routines drive this agent and must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## 24. Register all cron routines

Run after a DB reset or fresh Railway deploy. Requires a valid board API key (see Section 23 for how to create one).

```bash
TOKEN="pcp_board_railway_admin_key_2026"
BASE="https://api.ledgerixpro.com"
COMPANY_ID="f60117de-1131-433c-934f-3fe88bfaa163"

# 1. Sentinel — daily 6am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Daily Bookkeeping Run — Sentinel","description":"Runs every day at 6am Arizona time.","priority":"high","status":"active","assigneeAgentId":"51526544-e8db-4a6b-808e-b02950c527d2"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 6 * * *","timezone":"America/Phoenix"}'
echo "Sentinel routine: $ROUTINE_ID"

# 2. Senior Bookkeeper weekly digest — Monday 8am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly Client Digest — Senior Bookkeeper","description":"Runs every Monday at 8am Arizona time.","priority":"high","status":"active","assigneeAgentId":"2b00ead7-c1e6-4b87-b0dc-8294d54b463c"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 8 * * 1","timezone":"America/Phoenix"}'
echo "Senior Bookkeeper digest routine: $ROUTINE_ID"

# 3. Reactivation nurture — monthly 1st 9am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Monthly Nurture Run — Reactivation","description":"Runs on the 1st of every month at 9am Arizona time.","priority":"medium","status":"active","assigneeAgentId":"7f5a3ce8-4c90-4fcb-8559-66372c374a83"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 9 1 * *","timezone":"America/Phoenix"}'
echo "Reactivation routine: $ROUTINE_ID"

# 4. Billing & Invoicing — monthly 1st 8am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Monthly Billing Run — Billing & Invoicing","description":"Runs on the 1st of every month at 8am Arizona time.","priority":"high","status":"active","assigneeAgentId":"7115530d-0aa6-4315-a3c9-3a81d6de2e84"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 8 1 * *","timezone":"America/Phoenix"}'
echo "Billing routine: $ROUTINE_ID"

# 5. AP Specialist daily scan — 6:30am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Daily AP Scan — AP Specialist","description":"Runs daily at 6:30am Arizona.","priority":"high","status":"active","assigneeAgentId":"d1800e52-cb15-4880-bf26-578bab350939"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"30 6 * * *","timezone":"America/Phoenix"}'
echo "AP daily scan routine: $ROUTINE_ID"

# 6. AP Specialist weekly summary — Monday 8:30am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly AP Summary — AP Specialist","description":"Runs every Monday at 8:30am Arizona.","priority":"medium","status":"active","assigneeAgentId":"d1800e52-cb15-4880-bf26-578bab350939"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"30 8 * * 1","timezone":"America/Phoenix"}'
echo "AP weekly summary routine: $ROUTINE_ID"

# 7. Tax Liaison daily scan — 7am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Daily Tax Scan — Tax Liaison","description":"Runs daily at 7am Arizona. Scans tax deadlines for 7-day urgent alerts.","priority":"high","status":"active","assigneeAgentId":"c171e3a1-0d6d-4b94-87c3-032a4d001b0e"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 7 * * *","timezone":"America/Phoenix"}'
echo "Tax daily scan routine: $ROUTINE_ID"

# 8. Tax Liaison weekly review — Monday 9am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly Tax Review — Tax Liaison","description":"Runs every Monday at 9am Arizona. Sends 30-day tax planning reminders with YTD P&L summary.","priority":"medium","status":"active","assigneeAgentId":"c171e3a1-0d6d-4b94-87c3-032a4d001b0e"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 9 * * 1","timezone":"America/Phoenix"}'
echo "Tax weekly review routine: $ROUTINE_ID"

# 9. Reporter weekly pulse — Monday 7:30am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly Pulse — Reporter","description":"Runs every Monday at 7:30am Arizona. Sends weekly business pulse to scott@ledgerixpro.com.","priority":"medium","status":"active","assigneeAgentId":"847a94fa-5d1b-4210-8ac7-fd3866fabb7e"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"30 7 * * 1","timezone":"America/Phoenix"}'
echo "Reporter weekly pulse routine: $ROUTINE_ID"

# 10. Reporter monthly deep dive — 1st of month 7am Arizona
ROUTINE_ID=$(curl -s -X POST "$BASE/api/companies/$COMPANY_ID/routines" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Monthly Deep Dive — Reporter","description":"Runs on the 1st of every month at 7am Arizona. Sends comprehensive monthly business report.","priority":"medium","status":"active","assigneeAgentId":"847a94fa-5d1b-4210-8ac7-fd3866fabb7e"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s -X POST "$BASE/api/routines/$ROUTINE_ID/triggers" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"schedule","cronExpression":"0 7 1 * *","timezone":"America/Phoenix"}'
echo "Reporter monthly deep dive routine: $ROUTINE_ID"
```

---

## 25. Restore the Tax Liaison agent configuration

After a DB reset and agent re-seed, restore the Tax Liaison agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/tax-liaison/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Tax Liaison'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/tax-liaison/AGENTS.md

Two cron routines drive this agent and must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## 26. Restore the Reporter agent configuration

After a DB reset and agent re-seed, restore the Reporter agent with:

```sql
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reporter/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Reporter'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```

The agent instructions file lives at:
agents/reporter/AGENTS.md

Two cron routines drive this agent and must be re-registered after a DB reset — see Section 24 for routine registration commands.

---

## Full reset sequence

```sh
# 1. Stop pnpm dev if running (Ctrl+C)

# 2. Wipe the database
rm -rf data/pglite

# 3. Start the server (re-creates and migrates the DB automatically)
pnpm dev

# 4. In a second terminal, re-seed the company row
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
  -c "INSERT INTO companies (id, name, status, issue_prefix, issue_counter, budget_monthly_cents, spent_monthly_cents) \
      VALUES ('f60117de-1131-433c-934f-3fe88bfaa163', 'Ledgerix Pro', 'active', 'LED', 1, 0, 0) \
      ON CONFLICT (id) DO NOTHING;"

# 5. Re-seed the 24-agent workforce
node_modules/.pnpm/node_modules/.bin/tsx scripts/seed-agents.ts

# 6. Cloudflare Tunnel starts automatically at login — no manual step needed
# Verify it is running with: cloudflared tunnel info ledgerix-pro

# 7. Restore the Onboarding agent config (see Section 11)
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/onboarding/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }'
WHERE name = 'Onboarding'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 8. Restore the SDR agent config (see Section 12)
psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-opus-4-7\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/sdr/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }'
WHERE name = 'SDR'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 9. Restore the CSM agent config (see Section 13)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/csm/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 25,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }'
WHERE name = 'Client Success Manager'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 10. Restore the Client Health Monitor agent config (see Section 14)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/client-health/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 30,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Client Health Monitor'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 11. Restore the AR Specialist agent config (see Section 15)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ar-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 20,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'AR Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 12. Restore the Sentinel agent config (see Section 16)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/sentinel/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Sentinel'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 13. Restore the Ledger Specialist agent config (see Section 17)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ledger-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 50,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Ledger Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 14. Restore the Reconciliation agent config (see Section 18)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reconciliation/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 50,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Reconciliation Agent'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 15. Restore the Senior Bookkeeper agent config (see Section 19)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-opus-4-7\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/senior-bookkeeper/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Senior Bookkeeper'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 16. Restore the Knowledge Base Manager agent config (see Section 20)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/knowledge-base-manager/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 30,
    \"timeoutSec\": 240
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Knowledge Base Manager'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 17. Restore the Reactivation agent config (see Section 21)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reactivation/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": false}'
WHERE name = 'Reactivation'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 18. Restore the Billing & Invoicing agent config (see Section 22)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/billing-invoicing/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": false}'
WHERE name = 'Billing & Invoicing'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 19. Restore the AP Specialist agent config (see Section 23)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/ap-specialist/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}',
  title = 'Accounts Payable Specialist'
WHERE name = 'AP Specialist'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 20. Restore the Tax Liaison agent config (see Section 25)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/tax-liaison/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Tax Liaison'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"

# 21. Restore the Reporter agent config (see Section 26)
/opt/homebrew/opt/libpq/bin/psql postgres://paperclip:paperclip@127.0.0.1:54329/paperclip -c "
UPDATE agents SET
  adapter_type = 'claude_local',
  adapter_config = '{
    \"command\": \"/Users/scotthansbury/.local/bin/claude\",
    \"model\": \"claude-sonnet-4-6\",
    \"instructionsFilePath\": \"/Users/scotthansbury/Projects/ledgerix-pro-core/agents/reporter/AGENTS.md\",
    \"dangerouslySkipPermissions\": true,
    \"maxTurnsPerRun\": 40,
    \"timeoutSec\": 300
  }',
  runtime_config = '{
    \"heartbeat\": {
      \"enabled\": true,
      \"maxConcurrentRuns\": 1
    }
  }',
  permissions = '{\"canCreateAgents\": false, \"canCreateIssues\": true}'
WHERE name = 'Reporter'
  AND company_id = 'f60117de-1131-433c-934f-3fe88bfaa163';
"
```
