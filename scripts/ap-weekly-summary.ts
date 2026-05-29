#!/usr/bin/env tsx
/**
 * AP Weekly Summary — Ledgerix Pro
 * Run by the AP Specialist agent every Monday at 8:30am Arizona time.
 * Sends a branded HTML AP overview email to every active client that has open bills.
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
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { qbo, xero } from "../server/src/services/accounting/index.js";
import type { Bill } from "../server/src/services/accounting/index.js";
import { ghlRequest, getFieldValue } from "../server/src/services/ghl/index.js";
import { ghl } from "../server/src/services/ghl/index.js";
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

function formatDate(d: string): string {
  if (!d) return "unknown";
  const parsed = new Date(d);
  if (isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

function getWeekLabel(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

async function fetchActiveClients(): Promise<GHLContact[]> {
  const params = new URLSearchParams({ locationId: LOCATION_ID });
  const res = await ghlRequest<GHLContactSearchResult>("GET", `/contacts/?${params}`);
  return (res.contacts ?? []).filter(
    (c) => Array.isArray(c.tags) && c.tags.includes("client-active"),
  );
}

async function getPlatformForClient(db: Db, clientCompanyId: string): Promise<"quickbooks" | "xero" | null> {
  const rows = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(eq(accountingConnections.companyId, clientCompanyId))
    .limit(1);
  const platform = rows[0]?.platform;
  if (platform === "quickbooks" || platform === "xero") return platform;
  return null;
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
// HTML email builder
// ---------------------------------------------------------------------------

function buildBillTableRows(bills: Array<{ vendorName: string; amount: number; dueDate: string; extra?: string }>): string {
  if (bills.length === 0) return "";
  return bills.map((b) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${b.vendorName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">$${formatAmount(b.amount)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${b.extra ?? formatDate(b.dueDate)}</td>
      </tr>`).join("");
}

function buildTableSection(title: string, headers: [string, string, string], rows: string, emptyMsg: string): string {
  return `
    <h3 style="color:#0F1E38;font-size:14px;font-weight:600;margin:24px 0 8px;">${title}</h3>
    ${rows ? `
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;font-weight:600;">${headers[0]}</th>
          <th style="padding:8px 12px;text-align:right;font-weight:600;">${headers[1]}</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;">${headers[2]}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>` : `<p style="color:#6b7280;font-size:13px;margin:0;">${emptyMsg}</p>`}`;
}

function buildWeeklySummaryEmail(
  firstName: string,
  weekLabel: string,
  dueSoon: Bill[],
  overdue: Bill[],
  upcoming: Bill[],
): string {
  const dueSoonRows = buildBillTableRows(
    dueSoon.map((b) => ({ vendorName: b.vendorName, amount: b.amount, dueDate: b.dueDate }))
  );
  const overdueRows = buildBillTableRows(
    overdue.map((b) => ({
      vendorName: b.vendorName,
      amount: b.amount,
      dueDate: b.dueDate,
      extra: `${Math.abs(b.daysDue)} day${Math.abs(b.daysDue) === 1 ? "" : "s"} overdue`,
    }))
  );
  const upcomingRows = buildBillTableRows(
    upcoming.map((b) => ({ vendorName: b.vendorName, amount: b.amount, dueDate: b.dueDate }))
  );

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr>
          <td style="background:#0F1E38;padding:24px 32px;">
            <p style="margin:0;color:#F5A623;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Ledgerix Pro</p>
            <h1 style="margin:4px 0 0;color:#ffffff;font-size:20px;font-weight:700;">AP Summary</h1>
            <p style="margin:4px 0 0;color:#94a3b8;font-size:13px;">Week of ${weekLabel}</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="color:#374151;font-size:14px;margin:0 0 4px;">Hi ${firstName},</p>
            <p style="color:#374151;font-size:14px;margin:0 0 24px;">Here's your accounts payable overview for this week.</p>

            ${buildTableSection(
              "Bills due this week (next 7 days)",
              ["Vendor", "Amount", "Due Date"],
              dueSoonRows,
              "No bills due this week ✓"
            )}

            ${buildTableSection(
              "Overdue bills",
              ["Vendor", "Amount", "Days Overdue"],
              overdueRows,
              "No overdue bills ✓"
            )}

            ${buildTableSection(
              "Upcoming (next 30 days)",
              ["Vendor", "Amount", "Due Date"],
              upcomingRows,
              "Nothing else due in the next 30 days"
            )}

            <hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 24px;">
            <p style="color:#6b7280;font-size:13px;margin:0 0 4px;">Questions about any of these? Reply to this email.</p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f9fafb;padding:20px 32px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;color:#374151;font-size:13px;font-weight:600;">Scott Hansbury</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px;">Founder &amp; CEO | Ledgerix Pro</p>
            <p style="margin:2px 0 0;color:#6b7280;font-size:12px;">scott@ledgerixpro.com | (480) 660-2815</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = createDb(process.env.DATABASE_URL!);
  const weekLabel = getWeekLabel();

  console.log("=== AP Weekly Summary — Starting ===");
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`Week of: ${weekLabel}`);

  const activeClients = await fetchActiveClients();
  console.log(`\nActive clients found: ${activeClients.length}`);

  if (activeClients.length === 0) {
    console.log("No active clients. Weekly summary complete with nothing to do.");
    await writeRunResults(0, 0, 0);
    return;
  }

  let clientsWithBills = 0;
  let summariesSent = 0;
  let clientsSkipped = 0;

  for (const contact of activeClients) {
    const firstName = contact.firstName ?? "there";
    const lastName = contact.lastName ?? "";
    const contactName = `${firstName} ${lastName}`.trim();
    const email = contact.email;
    const contactId = contact.id;

    const clientCompanyId = getFieldValue(contact, "ledgerix_workspace_id") as string | undefined;

    if (!clientCompanyId) {
      console.log(`  Skipping ${contactName} — no ledgerix_workspace_id`);
      clientsSkipped++;
      continue;
    }

    console.log(`\nProcessing: ${contactName} — workspace: ${clientCompanyId}`);

    const platform = await getPlatformForClient(db, clientCompanyId);
    if (!platform) {
      console.log(`  No accounting connection for ${contactName} — skipping`);
      clientsSkipped++;
      continue;
    }

    let bills: Bill[] = [];
    try {
      bills = platform === "quickbooks"
        ? await qbo.getBills(db, clientCompanyId, null)
        : await xero.getBills(db, clientCompanyId, null);
    } catch (err) {
      console.error(`  Error fetching bills for ${contactName}:`, err instanceof Error ? err.message : String(err));
      clientsSkipped++;
      continue;
    }

    console.log(`  Open bills: ${bills.length}`);

    if (bills.length === 0) {
      console.log(`  AP Weekly: skipping ${contactName} — no open bills`);
      clientsSkipped++;
      continue;
    }

    clientsWithBills++;

    // Classify bills into three buckets
    const dueSoon: Bill[] = [];   // due in 0-7 days
    const overdueBills: Bill[] = []; // past due (daysDue < 0)
    const upcoming: Bill[] = [];  // due in 8-30 days

    for (const bill of bills) {
      if (bill.daysDue < 0) {
        overdueBills.push(bill);
      } else if (bill.daysDue <= 7) {
        dueSoon.push(bill);
      } else if (bill.daysDue <= 30) {
        upcoming.push(bill);
      }
      // daysDue > 30 → omit from summary
    }

    console.log(`  Due soon (0-7d): ${dueSoon.length}, Overdue: ${overdueBills.length}, Upcoming (8-30d): ${upcoming.length}`);

    if (!email) {
      console.log(`  No email on file for ${contactName} — skipping send`);
      clientsSkipped++;
      continue;
    }

    const subject = `Your Ledgerix Pro AP Summary — Week of ${weekLabel}`;
    const htmlBody = buildWeeklySummaryEmail(firstName, weekLabel, dueSoon, overdueBills, upcoming);

    try {
      await ghl.conversations.sendEmail(LOCATION_ID, contactId, subject, htmlBody);
      console.log(`  ✓ Weekly AP summary sent to ${email}`);
      summariesSent++;
    } catch (err) {
      console.error(`  Email failed for ${contactName}:`, err instanceof Error ? err.message : String(err));
      clientsSkipped++;
    }
  }

  console.log(`\n=== Weekly Summary Complete ===`);
  console.log(`Clients with bills: ${clientsWithBills}`);
  console.log(`Summaries sent: ${summariesSent}`);
  console.log(`Clients skipped: ${clientsSkipped}`);

  await writeRunResults(clientsWithBills, summariesSent, clientsSkipped);
}

async function writeRunResults(clientsWithBills: number, summariesSent: number, clientsSkipped: number) {
  if (!PAPERCLIP_TASK_ID) {
    console.log("No PAPERCLIP_TASK_ID — skipping issue update");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const runMetrics = {
    type: "ap_weekly_summary",
    date: today,
    clientsWithBills,
    summariesSent,
    clientsSkipped,
  };

  const comment = `AP weekly summary complete. ${summariesSent} summaries sent. ${clientsSkipped} skipped (no open bills). Date: ${today}`;

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
