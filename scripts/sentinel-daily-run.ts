#!/usr/bin/env tsx
/**
 * Sentinel Daily Run — Ledgerix Pro
 * Run by the Sentinel agent at 6am Arizona time.
 * Pulls new transactions for all active clients and dispatches to the Ledger Specialist.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1);
    if (key && !(key in process.env)) {
      process.env[key] = raw.replace(/^(['"])(.*)\1$/s, "$2");
    }
  }
}

process.env.DATABASE_URL = "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

import { eq } from "drizzle-orm";
import { createDb } from "../packages/db/src/index.js";
import { accountingConnections, agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { getNewTransactions } from "../server/src/services/accounting/index.js";
import { ghlRequest } from "../server/src/services/ghl/index.js";
import type { GHLContact, GHLContactSearchResult } from "../server/src/services/ghl/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "f60117de-1131-433c-934f-3fe88bfaa163";
const PAPERCLIP_TASK_ID = process.env.PAPERCLIP_TASK_ID;
const PAPERCLIP_RUN_ID = process.env.PAPERCLIP_RUN_ID;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchActiveClients(): Promise<GHLContact[]> {
  const params = new URLSearchParams({ locationId: LOCATION_ID });
  const res = await ghlRequest<GHLContactSearchResult>("GET", `/contacts/?${params}`);
  return (res.contacts ?? []).filter(
    (c) => Array.isArray(c.tags) && c.tags.includes("client-active"),
  );
}

async function lookupAgentId(db: Db, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, name))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function paperclipPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAPERCLIP_API_KEY}`,
      "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`Paperclip POST ${path} failed ${res.status}: ${err}`);
    return null;
  }
  return res.json();
}

async function paperclipPatch(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${PAPERCLIP_API_KEY}`,
      "X-Paperclip-Run-Id": PAPERCLIP_RUN_ID ?? "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`Paperclip PATCH ${path} failed ${res.status}: ${err}`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

async function main() {
  const db = createDb(process.env.DATABASE_URL!);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  console.log("=== Sentinel Daily Run — Starting ===");
  console.log(`Date: ${today}  (pulling transactions since: ${yesterday})`);

  // Step 1 — Look up Ledger Specialist agent ID
  const ledgerSpecialistId = await lookupAgentId(db, "Ledger Specialist");
  console.log(`Ledger Specialist agent ID: ${ledgerSpecialistId}`);

  // Step 2 — Pull active clients
  const activeClients = await fetchActiveClients();
  console.log(`\nActive clients found: ${activeClients.length}`);

  if (activeClients.length === 0) {
    console.log("No active clients. Run complete.");
    await writeSummary(0, 0, [], []);
    return;
  }

  let clientsChecked = 0;
  let clientsWithTransactions = 0;
  const issuesCreated: string[] = [];
  const skippedNoConnection: string[] = [];

  for (const contact of activeClients) {
    const firstName = contact.firstName ?? "there";
    const lastName = contact.lastName ?? "";
    const contactName = `${firstName} ${lastName}`.trim();
    const contactId = contact.id;

    clientsChecked++;
    console.log(`\nClient: ${contactName} — contactId: ${contactId}`);

    // Pull transactions since yesterday using per-contact accounting connection
    let platform: "quickbooks" | "xero";
    let transactions: Awaited<ReturnType<typeof getNewTransactions>>["transactions"];

    try {
      const result = await getNewTransactions(db, PAPERCLIP_COMPANY_ID, contactId, yesterday);
      platform = result.platform;
      transactions = result.transactions;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection")) {
        console.log(`  Sentinel: no accounting connection for ${contactName} — skipping (may still be onboarding)`);
        skippedNoConnection.push(contactName);
        continue;
      }
      console.error(`  Error pulling transactions for ${contactName}:`, msg);
      skippedNoConnection.push(contactName);
      continue;
    }

    console.log(`  Sentinel: pulled ${transactions.length} transactions for ${contactName} (${platform})`);

    if (transactions.length === 0) {
      console.log(`  Sentinel: no new transactions for ${contactName}, skipping`);
      continue;
    }

    clientsWithTransactions++;

    // Step 3 — Create a Ledger Specialist issue
    if (!ledgerSpecialistId) {
      console.error(`  Cannot create issue — Ledger Specialist agent not found in DB`);
      continue;
    }

    const issueTitle = `Bookkeeping run — ${contactName} — ${today}`;
    const issueBody = [
      `**Client:** ${contactName}`,
      `**Contact ID:** ${contactId}`,
      `**Platform:** ${platform}`,
      `**Date:** ${today}`,
      `**Transactions (${transactions.length}):**`,
      "",
      "```json",
      JSON.stringify(transactions, null, 2),
      "```",
    ].join("\n");

    const created = await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
      title: issueTitle,
      description: issueBody,
      priority: "medium",
      status: "todo",
      assigneeAgentId: ledgerSpecialistId,
    }) as { id?: string; identifier?: string } | null;

    if (created?.id) {
      issuesCreated.push(created.id);
      console.log(`  ✓ Issue created: ${created.identifier ?? created.id} — ${issueTitle}`);
    }
  }

  console.log(`\n=== Sentinel Run Complete ===`);
  console.log(`Clients checked: ${clientsChecked}`);
  console.log(`Clients with new transactions: ${clientsWithTransactions}`);
  console.log(`Issues created: ${issuesCreated.length}`);
  console.log(`Clients skipped (no connection): ${skippedNoConnection.length}`);

  await writeSummary(clientsChecked, clientsWithTransactions, issuesCreated, skippedNoConnection);
}

async function writeSummary(
  clientsChecked: number,
  clientsWithTransactions: number,
  issuesCreated: string[],
  skippedNoConnection: string[],
) {
  if (!PAPERCLIP_TASK_ID) {
    console.log("No PAPERCLIP_TASK_ID — skipping issue update");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const runMetrics = {
    type: "sentinel_run",
    date: today,
    clientsChecked,
    clientsWithTransactions,
    clientsSkipped: skippedNoConnection.length,
    issuesCreated,
  };

  const comment = [
    `Sentinel daily run complete.`,
    `${clientsChecked} clients checked.`,
    `${clientsWithTransactions} clients had new transactions.`,
    issuesCreated.length > 0 ? `Issues created: ${issuesCreated.join(", ")}.` : "No issues created.",
    skippedNoConnection.length > 0
      ? `Clients skipped (no connection): ${skippedNoConnection.join(", ")}.`
      : "No clients skipped.",
    `Date: ${today}`,
  ].join(" ");

  await paperclipPatch(`/api/issues/${PAPERCLIP_TASK_ID}`, {
    status: "done",
    comment,
    runMetrics,
  });

  console.log(`\nPaperclip issue updated — status: done`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
