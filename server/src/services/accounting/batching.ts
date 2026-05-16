import type { Transaction } from "./index.js";

// How to group a flat array of transactions into batches for downstream
// processing. "per-contact" matches Sentinel's existing daily behavior
// (one issue per client containing all transactions for the window).
export type BatchStrategy = "monthly" | "weekly" | "per-contact";

export interface TransactionBatch {
  start: string;  // ISO date YYYY-MM-DD, inclusive
  end: string;    // ISO date YYYY-MM-DD, inclusive
  label: string;  // human-readable, e.g. "Week of 2026-04-27" or "April 2026"
  transactions: Transaction[];
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Xero returns dates in Microsoft .NET format: /Date(<epoch-ms>[+-]<offset>)/
// The millisecond timestamp is UTC epoch — the offset is informational only and
// must not be re-applied, or the date would double-shift. QBO returns ISO-8601,
// which `new Date(s)` handles directly. Fall through to native parsing for
// anything else.
const XERO_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

export function parseTransactionDate(s: string): Date {
  const xeroMatch = s.match(XERO_DATE_RE);
  if (xeroMatch) {
    const ms = parseInt(xeroMatch[1], 10);
    if (Number.isFinite(ms)) {
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid transaction date: ${s}`);
  }
  return d;
}

// Calendar-month boundaries in UTC for the month containing `d`.
function monthRange(d: Date): { key: string; start: string; end: string; label: string } {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 0)); // day 0 of next month = last day of this month
  return {
    key: `${year}-${pad(month + 1)}`,
    start: isoDate(start),
    end: isoDate(end),
    label: `${MONTH_NAMES[month]} ${year}`,
  };
}

// ISO 8601 week: Monday-start. Given a date, returns the Monday of its week.
function isoWeekMonday(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offsetToMonday = day === 0 ? -6 : 1 - day; // Sun -> -6, Mon -> 0, Sat -> -5
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetToMonday));
}

function weekRange(d: Date): { key: string; start: string; end: string; label: string } {
  const monday = isoWeekMonday(d);
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  const start = isoDate(monday);
  return {
    key: start, // Monday's ISO date is unique per ISO week
    start,
    end: isoDate(sunday),
    label: `Week of ${start}`,
  };
}

/**
 * Group transactions into batches by date according to `strategy`.
 *
 * - "monthly": one batch per calendar month containing transactions in that month.
 * - "weekly":  one batch per ISO 8601 week (Monday-start) containing transactions in that week.
 * - "per-contact": one batch containing ALL transactions (matches existing Sentinel behavior).
 *
 * Batches are returned in ascending date order. Transactions inside each batch
 * preserve the input order. Empty input returns an empty array.
 */
export function groupTransactionsByBatch(
  transactions: Transaction[],
  strategy: BatchStrategy,
): TransactionBatch[] {
  if (transactions.length === 0) return [];

  if (strategy === "per-contact") {
    // Compute date span from min/max without reordering the input.
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const tx of transactions) {
      const t = parseTransactionDate(tx.date).getTime();
      if (t < minTime) minTime = t;
      if (t > maxTime) maxTime = t;
    }
    return [{
      start: isoDate(new Date(minTime)),
      end: isoDate(new Date(maxTime)),
      label: "All transactions",
      transactions,
    }];
  }

  // monthly / weekly: bucket by key. Map preserves insertion order, but we
  // explicitly sort by start date at the end to handle out-of-order input.
  const buckets = new Map<string, { range: { start: string; end: string; label: string }; transactions: Transaction[] }>();
  for (const tx of transactions) {
    const d = parseTransactionDate(tx.date);
    const range = strategy === "monthly" ? monthRange(d) : weekRange(d);
    let entry = buckets.get(range.key);
    if (!entry) {
      entry = { range: { start: range.start, end: range.end, label: range.label }, transactions: [] };
      buckets.set(range.key, entry);
    }
    entry.transactions.push(tx);
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.range.start.localeCompare(b.range.start))
    .map((bucket) => ({
      start: bucket.range.start,
      end: bucket.range.end,
      label: bucket.range.label,
      transactions: bucket.transactions,
    }));
}
