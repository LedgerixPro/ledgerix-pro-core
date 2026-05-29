#!/usr/bin/env tsx
/**
 * Historical Sync — Ledgerix Pro
 *
 * One-shot backfill: pull historical transactions for ONE contact (driven by
 * the contact's intake_mode + optional intake_lookback_days custom fields),
 * group them into batches by date, and POST one Ledger Specialist issue per
 * batch directly to Paperclip's issues endpoint. Bypasses the routine system
 * entirely (Approach δ from the prior recon).
 *
 * Usage:
 *   npx tsx scripts/historical-sync.ts --contact-id=<ghl-contact-id> [--dry-run]
 *
 * Errors out if intake_mode is "active" or unset — daily Sentinel handles
 * active clients. This script is for first_books / catch_up / switchover.
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

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

import { writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb } from "../packages/db/src/index.js";
import { agents } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { getNewTransactions } from "../server/src/services/accounting/index.js";
import type { Transaction } from "../server/src/services/accounting/index.js";
import { groupTransactionsByBatch, parseTransactionDate } from "../server/src/services/accounting/batching.js";
import type { BatchStrategy, TransactionBatch } from "../server/src/services/accounting/batching.js";
import { ghl, getFieldValue } from "../server/src/services/ghl/index.js";
import type { GHLContact } from "../server/src/services/ghl/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100";
// The existing sentinel script uses PAPERCLIP_API_KEY; the routine-API docs
// reference PAPERCLIP_BOARD_API_KEY. Accept either so this script works in
// both environments without env renaming.
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_BOARD_API_KEY ?? process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "f60117de-1131-433c-934f-3fe88bfaa163";

type IntakeMode = "first_books" | "catch_up" | "switchover";

const MODE_DEFAULT_LOOKBACK: Record<IntakeMode, number> = {
  first_books: 730,
  catch_up: 365,
  switchover: 60,
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  contactId: string;
  dryRun: boolean;
  inspect: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let contactId: string | null = null;
  let dryRun = false;
  let inspect = false;
  for (const arg of argv) {
    if (arg.startsWith("--contact-id=")) {
      contactId = arg.slice("--contact-id=".length).trim();
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--inspect") {
      inspect = true;
    }
  }
  if (!contactId) {
    console.error("Usage: npx tsx scripts/historical-sync.ts --contact-id=<ghl-contact-id> [--dry-run|--inspect]");
    process.exit(2);
  }
  // --inspect wins over --dry-run if both are passed.
  if (inspect) dryRun = false;
  return { contactId, dryRun, inspect };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBatchStrategy(lookbackDays: number): BatchStrategy {
  if (lookbackDays > 180) return "monthly";
  if (lookbackDays >= 30) return "weekly";
  return "per-contact";
}

function todayMinusDays(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function fullContactName(contact: GHLContact): string {
  return `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim() || "Unknown";
}

// Read intake_lookback_days from a GHL contact, coercing string-numerics to
// numbers and rejecting non-positive values. Returns null when the field is
// blank/missing/zero (let the mode default take over).
function readLookbackOverride(contact: GHLContact): number | null {
  const raw = getFieldValue(contact, "intake_lookback_days");
  if (typeof raw === "number" && raw > 0) return Math.floor(raw);
  if (typeof raw === "string") {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function readIntakeMode(contact: GHLContact): string {
  const raw = getFieldValue(contact, "intake_mode");
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

async function lookupAgentId(db: Db, name: string): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.name, name))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function paperclipPost(p: string, body: unknown): Promise<{ id?: string; identifier?: string } | null> {
  if (!PAPERCLIP_API_KEY) {
    console.error("PAPERCLIP_API_KEY (or PAPERCLIP_BOARD_API_KEY) is not set — cannot POST to Paperclip.");
    return null;
  }
  const res = await fetch(`${PAPERCLIP_API_URL}${p}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${PAPERCLIP_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`  Paperclip POST ${p} failed ${res.status}: ${errText}`);
    return null;
  }
  return res.json() as Promise<{ id?: string; identifier?: string }>;
}

function buildIssueBody(args: {
  contactName: string;
  contactId: string;
  platform: "quickbooks" | "xero";
  batch: TransactionBatch;
  totalBatches: number;
  batchIndex: number;
}): string {
  const { contactName, contactId, platform, batch, totalBatches, batchIndex } = args;
  return [
    `**HISTORICAL SYNC** — This is a historical sync batch covering ${batch.start} to ${batch.end}.`,
    `Process each transaction with the same care as a normal daily run, but recognize these are existing transactions being categorized for the first time (not net-new since yesterday).`,
    ``,
    `**Client:** ${contactName}`,
    `**Contact ID:** ${contactId}`,
    `**Platform:** ${platform}`,
    `**Batch:** ${batch.label} (${batch.start} to ${batch.end})`,
    `**Batch ${batchIndex + 1} of ${totalBatches}** for this historical sync run`,
    `**Transactions (${batch.transactions.length}):**`,
    ``,
    "```json",
    JSON.stringify(batch.transactions, null, 2),
    "```",
  ].join("\n");
}

function printInspectSummary(args: {
  contact: GHLContact;
  platform: "quickbooks" | "xero";
  transactions: Transaction[];
}) {
  const { contact, platform, transactions } = args;
  const inspectPath = "/tmp/enyrgy-transactions-inspect.json";
  writeFileSync(inspectPath, JSON.stringify(transactions, null, 2), "utf-8");

  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  let reconciledTrue = 0;
  let reconciledFalse = 0;
  let reconciledNull = 0;
  let withAccountRef = 0;
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;

  for (const tx of transactions) {
    byType.set(tx.type, (byType.get(tx.type) ?? 0) + 1);
    const statusKey = tx.status ?? "(null)";
    byStatus.set(statusKey, (byStatus.get(statusKey) ?? 0) + 1);
    if (tx.isReconciled === true) reconciledTrue++;
    else if (tx.isReconciled === false) reconciledFalse++;
    else reconciledNull++;
    if (tx.accountRef && tx.accountRef.trim().length > 0) withAccountRef++;
    try {
      const t = parseTransactionDate(tx.date).getTime();
      if (t < minMs) minMs = t;
      if (t > maxMs) maxMs = t;
    } catch {
      // skip unparseable dates from min/max but still count the txn elsewhere
    }
  }

  const dateRange = Number.isFinite(minMs) && Number.isFinite(maxMs)
    ? `${new Date(minMs).toISOString().slice(0, 10)} → ${new Date(maxMs).toISOString().slice(0, 10)}`
    : "(no parseable dates)";

  const sortedType = Array.from(byType.entries()).sort((a, b) => b[1] - a[1]);
  const sortedStatus = Array.from(byStatus.entries()).sort((a, b) => b[1] - a[1]);

  console.log("\n=== Inspect summary ===");
  console.log(`Contact:           ${fullContactName(contact)} (${contact.id})`);
  console.log(`Platform:          ${platform}`);
  console.log(`Total:             ${transactions.length}`);
  console.log("By type:");
  for (const [t, n] of sortedType) console.log(`  ${t.padEnd(20, " ")} ${n}`);
  console.log("By status:");
  for (const [s, n] of sortedStatus) console.log(`  ${s.padEnd(20, " ")} ${n}`);
  console.log("By IsReconciled:");
  console.log(`  true                 ${reconciledTrue}`);
  console.log(`  false                ${reconciledFalse}`);
  console.log(`  null/undefined       ${reconciledNull}`);
  console.log(`Date range:        ${dateRange}`);
  console.log(`With accountRef:   ${withAccountRef} / ${transactions.length}`);
  console.log(`Raw JSON written:  ${inspectPath}`);
}

function printDryRunSummary(args: {
  contact: GHLContact;
  mode: IntakeMode;
  lookbackDays: number;
  lookbackSource: "override" | "mode default";
  sinceDate: string;
  strategy: BatchStrategy;
  platform: "quickbooks" | "xero";
  batches: TransactionBatch[];
  totalTransactions: number;
}) {
  const {
    contact, mode, lookbackDays, lookbackSource, sinceDate, strategy, platform, batches, totalTransactions,
  } = args;
  const companyName = (contact as { companyName?: string }).companyName ?? "(no company name on contact)";
  console.log("\n=== Historical Sync — DRY RUN ===");
  console.log(`Contact:        ${fullContactName(contact)} (${companyName})`);
  console.log(`Contact ID:     ${contact.id}`);
  console.log(`Intake mode:    ${mode}`);
  console.log(`Lookback:       ${lookbackDays} days (${lookbackSource})`);
  console.log(`Since date:     ${sinceDate}`);
  console.log(`Batch strategy: ${strategy}`);
  console.log(`Platform:       ${platform}`);
  console.log(`Transactions:   ${totalTransactions}`);
  console.log(`Batches:        ${batches.length}`);
  console.log("");
  console.log("Batches (would create one Ledger Specialist issue per batch):");
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    console.log(`  ${String(i + 1).padStart(2, " ")}. ${b.label.padEnd(24, " ")}  ${b.start} → ${b.end}  (${b.transactions.length} tx)`);
  }
  console.log("\nNo issues were created. Re-run without --dry-run to actually create issues.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = createDb(process.env.DATABASE_URL!);

  // Fetch the contact
  let contact: GHLContact;
  try {
    contact = await ghl.contacts.getContact(LOCATION_ID, args.contactId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to fetch GHL contact ${args.contactId}: ${msg}`);
    process.exit(1);
  }

  const contactName = fullContactName(contact);
  const rawMode = readIntakeMode(contact);

  // Validate intake_mode
  if (!rawMode || rawMode === "active") {
    console.error(`Contact intake_mode is 'active' or unset. Historical sync is for first_books/catch_up/switchover modes only.`);
    console.error(`Contact: ${contactName} (${args.contactId})`);
    console.error(`Read value: ${rawMode === "" ? "(empty/missing)" : `'${rawMode}'`}`);
    process.exit(1);
  }
  if (rawMode !== "first_books" && rawMode !== "catch_up" && rawMode !== "switchover") {
    console.error(`Unknown intake_mode value: '${rawMode}'. Expected one of: first_books, catch_up, switchover, active.`);
    process.exit(1);
  }
  const mode: IntakeMode = rawMode;

  // Resolve lookback
  const override = readLookbackOverride(contact);
  const lookbackDays = override ?? MODE_DEFAULT_LOOKBACK[mode];
  const lookbackSource: "override" | "mode default" = override !== null ? "override" : "mode default";
  const sinceDate = todayMinusDays(lookbackDays);
  const strategy = resolveBatchStrategy(lookbackDays);

  console.log(`Historical Sync — ${contactName} (${args.contactId})`);
  console.log(`Mode: ${mode}, lookback: ${lookbackDays} days (${lookbackSource}), since: ${sinceDate}, strategy: ${strategy}`);

  // Pull transactions
  let platform: "quickbooks" | "xero";
  let transactions: Transaction[];
  try {
    const result = await getNewTransactions(db, PAPERCLIP_COMPANY_ID, args.contactId, sinceDate);
    platform = result.platform;
    transactions = result.transactions;
  } catch (err) {
    console.error(`Failed to pull transactions for ${contactName}:`);
    if (err instanceof Error) {
      console.error(`  name:    ${err.name}`);
      console.error(`  message: ${err.message || "(empty)"}`);
      if (err.stack) {
        console.error(`  stack:`);
        for (const line of err.stack.split("\n")) console.error(`    ${line}`);
      }
      // Capture cause (non-enumerable on modern Error) and any custom own props
      // such as statusCode / response / body / code attached by HTTP clients.
      const extra: Record<string, unknown> = {};
      if ((err as { cause?: unknown }).cause !== undefined) extra.cause = (err as { cause?: unknown }).cause;
      for (const key of Object.keys(err)) extra[key] = (err as unknown as Record<string, unknown>)[key];
      if (Object.keys(extra).length > 0) {
        const replacer = (_k: string, v: unknown) =>
          v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
        console.error(`  extra:   ${JSON.stringify(extra, replacer, 2)}`);
      }
    } else {
      console.error(`  Non-Error thrown — typeof: ${typeof err}`);
      console.error(`  String(err): ${String(err)}`);
      try {
        const replacer = (_k: string, v: unknown) =>
          v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
        console.error(`  JSON:        ${JSON.stringify(err, replacer, 2)}`);
      } catch {
        console.error(`  (could not JSON.stringify the value)`);
      }
    }
    process.exit(1);
  }

  console.log(`Pulled ${transactions.length} transactions from ${platform}`);

  if (transactions.length === 0) {
    console.log("No transactions to sync.");
    process.exit(0);
  }

  if (args.inspect) {
    printInspectSummary({ contact, platform, transactions });
    process.exit(0);
  }

  const batches = groupTransactionsByBatch(transactions, strategy);

  if (args.dryRun) {
    printDryRunSummary({
      contact,
      mode,
      lookbackDays,
      lookbackSource,
      sinceDate,
      strategy,
      platform,
      batches,
      totalTransactions: transactions.length,
    });
    process.exit(0);
  }

  // Real run — look up Ledger Specialist agent ID and create issues
  const ledgerSpecialistId = await lookupAgentId(db, "Ledger Specialist");
  if (!ledgerSpecialistId) {
    console.error("Ledger Specialist agent not found in DB — cannot create issues.");
    process.exit(1);
  }
  console.log(`Ledger Specialist agent ID: ${ledgerSpecialistId}\n`);

  const created: Array<{ batch: string; id: string; identifier: string | null }> = [];
  const failed: string[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const issueTitle = `Historical sync — ${contactName} — ${batch.label}`;
    const issueBody = buildIssueBody({
      contactName,
      contactId: args.contactId,
      platform,
      batch,
      totalBatches: batches.length,
      batchIndex: i,
    });
    const res = await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
      title: issueTitle,
      description: issueBody,
      priority: "medium",
      status: "todo",
      assigneeAgentId: ledgerSpecialistId,
    });
    if (res?.id) {
      created.push({ batch: batch.label, id: res.id, identifier: res.identifier ?? null });
      console.log(`  ✓ [${i + 1}/${batches.length}] ${batch.label} → issue ${res.identifier ?? res.id} (${batch.transactions.length} tx)`);
    } else {
      failed.push(batch.label);
      console.error(`  ✗ [${i + 1}/${batches.length}] ${batch.label} — issue creation failed`);
    }
  }

  // Final summary
  const oldest = batches[0];
  const newest = batches[batches.length - 1];
  console.log("\n=== Historical Sync Complete ===");
  console.log(`Contact:           ${contactName} (${args.contactId})`);
  console.log(`Batches created:   ${created.length} / ${batches.length}`);
  console.log(`Transactions:      ${transactions.length}`);
  console.log(`Date range:        ${oldest.start} to ${newest.end}`);
  console.log(`Dashboard:         ${PAPERCLIP_API_URL}/dashboard`);
  if (failed.length > 0) {
    console.log(`\nFAILED batches (${failed.length}):`);
    for (const label of failed) console.log(`  - ${label}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
