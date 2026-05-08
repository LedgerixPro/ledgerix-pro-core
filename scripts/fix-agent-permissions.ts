#!/usr/bin/env tsx
/**
 * Set canCreateAgents and canAssignTasks on all 24 agents.
 * Executives (CEO, CFO, COO, CRO) → both true.
 * All other agents                → both false.
 *
 * Usage:
 *   node_modules/.pnpm/node_modules/.bin/tsx scripts/fix-agent-permissions.ts
 *
 * Idempotent — patches every agent unconditionally; repeated runs produce
 * the same result.
 */

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const API_BASE = "http://localhost:3100/api";

const EXECUTIVES = new Set(["CEO", "CFO", "COO", "CRO"]);

const EXECUTIVE_BUDGETS: Record<string, number> = {
  CEO: 2000,
  CFO: 1500,
  COO: 1000,
  CRO: 1000,
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchAgents(): Promise<Array<{ id: string; name: string }>> {
  const res = await fetch(`${API_BASE}/companies/${COMPANY_ID}/agents`);
  if (!res.ok) {
    throw new Error(`Failed to fetch agents: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<Array<{ id: string; name: string }>>;
}

async function patchPermissions(
  agentId: string,
  canCreateAgents: boolean,
  canAssignTasks: boolean,
): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/permissions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ canCreateAgents, canAssignTasks }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
}

async function patchBudget(agentId: string, budgetMonthlyCents: number): Promise<void> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/budgets`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budgetMonthlyCents }),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Fixing agent permissions for company ${COMPANY_ID}\n`);

  const agents = await fetchAgents();
  if (agents.length === 0) {
    console.error("No agents found — run scripts/seed-agents.ts first.");
    process.exit(1);
  }

  console.log(`Found ${agents.length} agent(s).\n`);

  let ok = 0;
  let failed = 0;

  for (const agent of agents) {
    const isExec = EXECUTIVES.has(agent.name);
    const canCreateAgents = isExec;
    const canAssignTasks = isExec;
    const tag = isExec ? "EXEC " : "STAFF";

    try {
      await patchPermissions(agent.id, canCreateAgents, canAssignTasks);
      console.log(
        `  OK  [${tag}]  ${agent.name.padEnd(26)} canCreateAgents=${String(canCreateAgents).padEnd(5)}  canAssignTasks=${canAssignTasks}`,
      );
      ok++;
    } catch (err) {
      console.error(`  FAIL [${tag}]  ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Permissions updated : ${ok}
  Permissions failed  : ${failed}
  Total               : ${agents.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // ── Budget phase ──────────────────────────────────────────────────────────
  console.log("\nSetting budget caps...\n");

  let budgetOk = 0;
  let budgetFailed = 0;

  for (const agent of agents) {
    const budgetMonthlyCents = EXECUTIVE_BUDGETS[agent.name] ?? 0;
    const tag = EXECUTIVES.has(agent.name) ? "EXEC " : "STAFF";

    try {
      await patchBudget(agent.id, budgetMonthlyCents);
      console.log(
        `  OK  [${tag}]  ${agent.name.padEnd(26)} budgetMonthlyCents=${budgetMonthlyCents}`,
      );
      budgetOk++;
    } catch (err) {
      console.error(`  FAIL [${tag}]  ${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
      budgetFailed++;
    }
  }

  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Budgets updated : ${budgetOk}
  Budgets failed  : ${budgetFailed}
  Total           : ${agents.length}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  if (failed > 0 || budgetFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
