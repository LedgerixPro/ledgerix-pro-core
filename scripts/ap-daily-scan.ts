#!/usr/bin/env tsx
/**
 * AP Daily Scan — Ledgerix Pro
 * Run by the AP Specialist agent at 6:30am Arizona time.
 * Scans all active client bills for 7-day warnings and overdue alerts.
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
const SCOTT_CONTACT_ID = "gBXAAfW70w2tGTKhT0IQ";

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

function clientEmailBody7Day(firstName: string, vendorName: string, amount: number, dueDate: string, daysUntil: number): string {
  return `<p>Hi ${firstName}, just a heads up — you have a bill due in ${daysUntil} day${daysUntil === 1 ? "" : "s"}:</p>
<ul>
  <li><strong>Vendor:</strong> ${vendorName}</li>
  <li><strong>Amount:</strong> $${formatAmount(amount)}</li>
  <li><strong>Due:</strong> ${formatDate(dueDate)}</li>
</ul>
<p>If you need help with timing or have questions, just reply.</p>
<p>— Scott Hansbury, Ledgerix Pro</p>`;
}

function clientEmailBodyOverdue(firstName: string, vendorName: string, amount: number, dueDate: string, daysOverdue: number): string {
  return `<p>Hi ${firstName}, you have an overdue bill that needs attention:</p>
<ul>
  <li><strong>Vendor:</strong> ${vendorName}</li>
  <li><strong>Amount:</strong> $${formatAmount(amount)}</li>
  <li><strong>Was due:</strong> ${formatDate(dueDate)} (${daysOverdue} day${daysOverdue === 1 ? "" : "s"} ago)</li>
</ul>
<p>Let us know if you'd like help getting this paid or if there's a dispute.</p>
<p>— Scott Hansbury, Ledgerix Pro</p>`;
}

function truncateSms(msg: string, maxLen = 160): string {
  return msg.length > maxLen ? msg.slice(0, maxLen - 1) + "…" : msg;
}

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------

async function main() {
  const db = createDb(process.env.DATABASE_URL!);

  console.log("=== AP Daily Scan — Starting ===");
  console.log(`Date: ${new Date().toISOString()}`);

  // Step 1 — Look up agent IDs
  const [cfoId, seniorBookkeeperId, clientHealthMonitorId] = await Promise.all([
    lookupAgentId(db, "CFO"),
    lookupAgentId(db, "Senior Bookkeeper"),
    lookupAgentId(db, "Client Health Monitor"),
  ]);

  console.log(`Agent IDs — CFO: ${cfoId}, Senior Bookkeeper: ${seniorBookkeeperId}, Client Health Monitor: ${clientHealthMonitorId}`);

  // Step 2 — Pull active clients
  const activeClients = await fetchActiveClients();
  console.log(`\nActive clients found: ${activeClients.length}`);

  if (activeClients.length === 0) {
    console.log("No active clients with client-active tag. Scan complete with nothing to do.");
    await writeScanResults(0, 0, 0, 0);
    return;
  }

  let clientsScanned = 0;
  let warningsSent = 0;
  let overdueAlertsSent = 0;
  let seriouslyOverdueAlertsSent = 0;

  for (const contact of activeClients) {
    const firstName = contact.firstName ?? "there";
    const lastName = contact.lastName ?? "";
    const contactName = `${firstName} ${lastName}`.trim();
    const companyName = (contact as { companyName?: string }).companyName ?? contactName;
    const email = contact.email;
    const contactId = contact.id;

    const clientCompanyId = getFieldValue(contact, "ledgerix_workspace_id") as string | undefined;

    if (!clientCompanyId) {
      console.log(`  Skipping ${contactName} — no ledgerix_workspace_id`);
      continue;
    }

    clientsScanned++;
    console.log(`\nScanning: ${contactName} (${companyName}) — workspace: ${clientCompanyId}`);

    const platform = await getPlatformForClient(db, clientCompanyId);
    if (!platform) {
      console.log(`  No accounting connection for ${contactName}`);
      continue;
    }

    console.log(`  Platform: ${platform}`);

    let bills: Bill[] = [];
    try {
      bills = platform === "quickbooks"
        ? await qbo.getBills(db, clientCompanyId, null)
        : await xero.getBills(db, clientCompanyId, null);
    } catch (err) {
      console.error(`  Error fetching bills for ${contactName}:`, err instanceof Error ? err.message : String(err));
      continue;
    }

    console.log(`  Open bills: ${bills.length}`);

    for (const bill of bills) {
      const { vendorName, amount, dueDate, daysDue } = bill;

      // daysDue > 0 = days until due (future)
      // daysDue < 0 = days overdue (past)
      // daysDue === 0 = due today

      if (daysDue > 7) {
        // Due in 8+ days — skip
        continue;
      }

      if (daysDue >= 0 && daysDue <= 7) {
        // 7-DAY WARNING
        const daysUntil = daysDue;
        console.log(`  7-DAY WARNING: ${vendorName} $${formatAmount(amount)} due in ${daysUntil} days`);

        // Send client email
        if (email) {
          try {
            await ghl.conversations.sendEmail(
              LOCATION_ID,
              contactId,
              `Upcoming bill due soon — ${vendorName} $${formatAmount(amount)}`,
              clientEmailBody7Day(firstName, vendorName, amount, dueDate, daysUntil),
            );
            console.log(`  ✓ 7-day warning email sent to ${email}`);
          } catch (err) {
            console.error(`  Email failed for ${contactName}:`, err instanceof Error ? err.message : String(err));
          }
        }

        // Send SMS to Scott
        const smsMsg = truncateSms(
          `AP: ${firstName} (${companyName}) — ${vendorName} $${formatAmount(amount)} due ${formatDate(dueDate)}`
        );
        try {
          await ghl.conversations.sendSms(LOCATION_ID, SCOTT_CONTACT_ID, smsMsg);
          console.log(`  ✓ 7-day warning SMS sent to Scott`);
        } catch (err) {
          console.log(`  SMS to Scott failed (A2P?), logging and continuing:`, err instanceof Error ? err.message : String(err));
        }

        warningsSent++;

      } else if (daysDue < 0 && daysDue >= -29) {
        // OVERDUE 1-29 days
        const daysOverdue = Math.abs(daysDue);
        console.log(`  OVERDUE (${daysOverdue}d): ${vendorName} $${formatAmount(amount)}`);

        // Send client email
        if (email) {
          try {
            await ghl.conversations.sendEmail(
              LOCATION_ID,
              contactId,
              `Overdue bill needs attention — ${vendorName} $${formatAmount(amount)}`,
              clientEmailBodyOverdue(firstName, vendorName, amount, dueDate, daysOverdue),
            );
            console.log(`  ✓ Overdue email sent to ${email}`);
          } catch (err) {
            console.error(`  Overdue email failed for ${contactName}:`, err instanceof Error ? err.message : String(err));
          }
        }

        // Add ap-overdue tag to GHL contact
        try {
          await ghl.contacts.addTag(LOCATION_ID, contactId, "ap-overdue");
          console.log(`  ✓ Tag ap-overdue added to ${contactName}`);
        } catch (err) {
          console.error(`  Failed to add ap-overdue tag:`, err instanceof Error ? err.message : String(err));
        }

        // Create CFO issue (high priority)
        if (cfoId) {
          await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
            title: `AP Overdue — ${contactName} — ${vendorName} $${formatAmount(amount)} ${daysOverdue} days overdue`,
            priority: "high",
            status: "todo",
            assigneeAgentId: cfoId,
          });
          console.log(`  ✓ CFO issue created`);
        }

        // Create Client Health Monitor issue (medium priority)
        if (clientHealthMonitorId) {
          await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
            title: `AP health signal — ${contactName} — overdue bill ${vendorName} $${formatAmount(amount)}`,
            priority: "medium",
            status: "todo",
            assigneeAgentId: clientHealthMonitorId,
          });
          console.log(`  ✓ Client Health Monitor issue created`);
        }

        // Send SMS to Scott
        const smsMsg = truncateSms(
          `AP OVERDUE: ${firstName} (${companyName}) — ${vendorName} $${formatAmount(amount)} ${daysOverdue} days past due`
        );
        try {
          await ghl.conversations.sendSms(LOCATION_ID, SCOTT_CONTACT_ID, smsMsg);
          console.log(`  ✓ Overdue SMS sent to Scott`);
        } catch (err) {
          console.log(`  SMS to Scott failed (A2P?), logging and continuing:`, err instanceof Error ? err.message : String(err));
        }

        overdueAlertsSent++;

      } else if (daysDue <= -30) {
        // SERIOUSLY OVERDUE 30+ days
        const daysOverdue = Math.abs(daysDue);
        console.log(`  SERIOUSLY OVERDUE (${daysOverdue}d): ${vendorName} $${formatAmount(amount)}`);

        // Send client email (overdue template)
        if (email) {
          try {
            await ghl.conversations.sendEmail(
              LOCATION_ID,
              contactId,
              `Overdue bill needs attention — ${vendorName} $${formatAmount(amount)}`,
              clientEmailBodyOverdue(firstName, vendorName, amount, dueDate, daysOverdue),
            );
            console.log(`  ✓ Seriously-overdue email sent to ${email}`);
          } catch (err) {
            console.error(`  Seriously-overdue email failed for ${contactName}:`, err instanceof Error ? err.message : String(err));
          }
        }

        // Add ap-overdue tag
        try {
          await ghl.contacts.addTag(LOCATION_ID, contactId, "ap-overdue");
          console.log(`  ✓ Tag ap-overdue added to ${contactName}`);
        } catch (err) {
          console.error(`  Failed to add ap-overdue tag:`, err instanceof Error ? err.message : String(err));
        }

        // Create CFO issue (high priority)
        if (cfoId) {
          await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
            title: `AP Overdue — ${contactName} — ${vendorName} $${formatAmount(amount)} ${daysOverdue} days overdue`,
            priority: "high",
            status: "todo",
            assigneeAgentId: cfoId,
          });
          console.log(`  ✓ CFO issue created`);
        }

        // Create Client Health Monitor issue (medium priority)
        if (clientHealthMonitorId) {
          await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
            title: `AP health signal — ${contactName} — overdue bill ${vendorName} $${formatAmount(amount)}`,
            priority: "medium",
            status: "todo",
            assigneeAgentId: clientHealthMonitorId,
          });
          console.log(`  ✓ Client Health Monitor issue created`);
        }

        // Create Senior Bookkeeper issue (urgent priority)
        if (seniorBookkeeperId) {
          await paperclipPost(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
            title: `AP Seriously Overdue — ${contactName} — ${vendorName} $${formatAmount(amount)} ${daysOverdue} days — assess financial statement impact`,
            priority: "critical",
            status: "todo",
            assigneeAgentId: seniorBookkeeperId,
          });
          console.log(`  ✓ Senior Bookkeeper issue created (urgent)`);
        }

        // Send escalation email to Scott
        try {
          await ghlRequest("POST", "/conversations/messages", {
            type: "Email",
            contactId: SCOTT_CONTACT_ID,
            subject: `Action required: ${contactName} has bill ${daysOverdue} days overdue — ${vendorName} $${formatAmount(amount)}`,
            html: `<p>Hi Scott,</p>
<p>${contactName} has a bill that is <strong>${daysOverdue} days overdue</strong> and needs attention:</p>
<ul>
  <li><strong>Client:</strong> ${contactName} (${companyName})</li>
  <li><strong>Vendor:</strong> ${vendorName}</li>
  <li><strong>Amount:</strong> $${formatAmount(amount)}</li>
  <li><strong>Was due:</strong> ${formatDate(dueDate)} (${daysOverdue} days ago)</li>
</ul>
<p>AP Specialist — Ledgerix Pro</p>`,
          });
          console.log(`  ✓ Escalation email sent to Scott`);
        } catch (err) {
          console.error(`  Escalation email to Scott failed:`, err instanceof Error ? err.message : String(err));
        }

        // Send SMS to Scott
        const smsMsg = truncateSms(
          `AP SERIOUS: ${firstName} (${companyName}) — ${vendorName} $${formatAmount(amount)} ${daysOverdue} days overdue. Email sent.`
        );
        try {
          await ghl.conversations.sendSms(LOCATION_ID, SCOTT_CONTACT_ID, smsMsg);
          console.log(`  ✓ Seriously-overdue SMS sent to Scott`);
        } catch (err) {
          console.log(`  SMS to Scott failed (A2P?), logging and continuing:`, err instanceof Error ? err.message : String(err));
        }

        seriouslyOverdueAlertsSent++;
        overdueAlertsSent++;
      }
    }
  }

  console.log(`\n=== Scan Complete ===`);
  console.log(`Clients scanned: ${clientsScanned}`);
  console.log(`7-day warnings: ${warningsSent}`);
  console.log(`Overdue (1-29d): ${overdueAlertsSent - seriouslyOverdueAlertsSent}`);
  console.log(`Seriously overdue (30d+): ${seriouslyOverdueAlertsSent}`);

  await writeScanResults(clientsScanned, warningsSent, overdueAlertsSent, seriouslyOverdueAlertsSent);
}

async function writeScanResults(
  clientsScanned: number,
  warningsSent: number,
  overdueAlertsSent: number,
  seriouslyOverdueAlertsSent: number,
) {
  if (!PAPERCLIP_TASK_ID) {
    console.log("No PAPERCLIP_TASK_ID — skipping issue update");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  const runMetrics = {
    type: "ap_daily_scan",
    date: today,
    clientsScanned,
    warningsSent,
    overdueAlertsSent,
    seriouslyOverdueAlertsSent,
  };

  const comment = `AP daily scan complete. ${clientsScanned} clients scanned. ${warningsSent} 7-day warnings. ${overdueAlertsSent - seriouslyOverdueAlertsSent} overdue (1-29d). ${seriouslyOverdueAlertsSent} seriously overdue (30d+). Date: ${today}`;

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
