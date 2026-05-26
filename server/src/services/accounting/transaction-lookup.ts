// Phase 4c.5 Decision 4 — get-transaction-by-id infrastructure.
//
// Unified per-transaction lookup behind a single getTransactionById(...)
// function. Each platform has its own type-specific fetch handler returning
// a unified TransactionLookupResult shape; the dispatcher routes to the
// right handler based on the platform (from accounting_connections) and
// optionally a hintedType to skip multi-type probing.
//
// Pattern established Session 3 (2026-05-26). Initial coverage: QBO Purchase,
// QBO Bill, Xero BankTransaction. Remaining types per Decision 4 checklist:
// QBO JournalEntry, Deposit, BillPayment, Payment, Invoice; Xero Invoices,
// Bills, ManualJournals.

import { and, eq, isNull } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { qboRequest } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import { logger } from "../../middleware/logger.js";

// Same SQL null-equality pattern used in qbo-client.ts and xero-client.ts:
// column = NULL never matches in SQL, so use isNull() for null contactId.
// See Phase 4c.5 Defect 1 (Session 3) for the equivalent fix on compareAndSeed.
function contactFilter(contactId: string | null) {
  return contactId === null
    ? isNull(accountingConnections.contactId)
    : eq(accountingConnections.contactId, contactId);
}

// ---------------------------------------------------------------------------
// Unified result type (Decision 4 lock)
// ---------------------------------------------------------------------------

export interface TransactionLookupResult {
  txnId: string;
  platform: "quickbooks" | "xero";
  txnType: string;
  previousAccountRef: string | null;
  raw: Record<string, unknown>;
}

export class TransactionNotFoundError extends Error {
  constructor(
    public readonly txnId: string,
    public readonly platform: string,
    public readonly attemptedTypes: readonly string[],
  ) {
    super(
      `Transaction ${txnId} not found on ${platform}; attempted types: ${attemptedTypes.join(", ")}`,
    );
    this.name = "TransactionNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Platform-specific minimal interfaces
//
// Each follows the established pattern: only the fields the code touches,
// with [key: string]: unknown catch-all. See QboPurchaseFull/XeroBankTransactionFull
// in services/accounting/index.ts for the same pattern applied to the
// existing handlers (now superseded by these).
// ---------------------------------------------------------------------------

interface QboPurchaseLineAccountBased {
  AccountBasedExpenseLineDetail?: {
    AccountRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboPurchaseFull {
  Id: string;
  SyncToken: string;
  Line?: QboPurchaseLineAccountBased[];
  [key: string]: unknown;
}

interface QboBillLine {
  AccountBasedExpenseLineDetail?: {
    AccountRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboBillFull {
  Id: string;
  SyncToken: string;
  Line?: QboBillLine[];
  [key: string]: unknown;
}

interface XeroBankTransactionLineItem {
  LineItemID?: string;
  AccountCode?: string;
  Description?: string;
  [key: string]: unknown;
}

interface XeroBankTransactionFull {
  BankTransactionID: string;
  LineItems?: XeroBankTransactionLineItem[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Per-type fetch handlers (private to this module)
// ---------------------------------------------------------------------------

async function fetchQboPurchase(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ Purchase: QboPurchaseFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/purchase/${txnId}`,
  );
  const purchase = response.Purchase;
  if (!purchase) {
    throw new Error(`QBO Purchase ${txnId} response missing Purchase field`);
  }
  const firstLine = purchase.Line?.[0];
  const previousAccountRef =
    firstLine?.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "Purchase",
    previousAccountRef,
    raw: purchase,
  };
}

async function fetchQboBill(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ Bill: QboBillFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/bill/${txnId}`,
  );
  const bill = response.Bill;
  if (!bill) {
    throw new Error(`QBO Bill ${txnId} response missing Bill field`);
  }
  const firstLine = bill.Line?.[0];
  const previousAccountRef =
    firstLine?.AccountBasedExpenseLineDetail?.AccountRef?.value ?? null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "Bill",
    previousAccountRef,
    raw: bill,
  };
}

async function fetchXeroBankTransaction(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await xeroRequest<{ BankTransactions?: XeroBankTransactionFull[] }>(
    db,
    companyId,
    contactId,
    "GET",
    `/BankTransactions/${txnId}`,
  );
  const txn = response.BankTransactions?.[0];
  if (!txn) {
    throw new Error(`Xero BankTransaction ${txnId} not found in response`);
  }
  const firstLine = txn.LineItems?.[0];
  const previousAccountRef = firstLine?.AccountCode ?? null;
  return {
    txnId,
    platform: "xero",
    txnType: "BankTransaction",
    previousAccountRef,
    raw: txn,
  };
}

// ---------------------------------------------------------------------------
// Type registry — per platform, ordered by frequency-of-use intuition
// (Purchase / BankTransaction are most common in agent recategorization).
// ---------------------------------------------------------------------------

type FetchHandler = (
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
) => Promise<TransactionLookupResult>;

const QBO_TYPE_REGISTRY: ReadonlyMap<string, FetchHandler> = new Map([
  ["Purchase", fetchQboPurchase],
  ["Bill", fetchQboBill],
  // Future: JournalEntry, Deposit, BillPayment, Payment, Invoice
]);

const XERO_TYPE_REGISTRY: ReadonlyMap<string, FetchHandler> = new Map([
  ["BankTransaction", fetchXeroBankTransaction],
  // Future: Invoice, Bill, ManualJournal
]);

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Look up a transaction by ID across the platform connected for this contact.
 *
 * Optional hintedType short-circuits the multi-type probe loop — callers who
 * already know the type (e.g., the existing updateTransactionAccount handlers)
 * can pass it to avoid wasted API calls. Without a hint, the dispatcher tries
 * each registered type for the platform until one succeeds.
 *
 * Throws TransactionNotFoundError if no registered handler returns a result.
 * Callers should route this to the
 * accounting.transaction.category_with_unknown_previous approval flow per
 * Phase 4c.4 dispatcher.
 *
 * NOTE on multi-type probing: today (Session 3), only one type per platform
 * is registered, so the probing loop is single-iteration. When a second type
 * per platform is added (e.g., QBO Bill alongside Purchase), error
 * discrimination becomes necessary — currently qboRequest/xeroRequest throw
 * generic Error on 404 with no structured status, so a "wrong type" 404 is
 * indistinguishable from a transient 500 in the catch handler. That work is
 * deferred to "implement second type per platform" per Decision 4 (today's
 * scope is the dispatcher signature and first-type registration).
 */
export async function getTransactionById(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
  hintedType?: string,
): Promise<TransactionLookupResult> {
  const connection = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        contactFilter(contactId),
      ),
    )
    .limit(1);

  if (connection.length === 0) {
    throw new Error(
      `No accounting connection found for companyId=${companyId} contactId=${contactId}`,
    );
  }

  const platform = connection[0].platform;
  const registry =
    platform === "quickbooks"
      ? QBO_TYPE_REGISTRY
      : platform === "xero"
        ? XERO_TYPE_REGISTRY
        : null;

  if (!registry) {
    throw new Error(`Unsupported accounting platform: ${platform}`);
  }

  // Hinted-type fast path: skip probing.
  if (hintedType !== undefined) {
    const handler = registry.get(hintedType);
    if (!handler) {
      throw new Error(
        `Unknown ${platform} transaction type: ${hintedType}. Registered types: ${[...registry.keys()].join(", ")}`,
      );
    }
    return await handler(db, companyId, contactId, txnId);
  }

  // Multi-type probing (single-iteration today; see NOTE above on error
  // discrimination work deferred to "second type per platform").
  const attemptedTypes: string[] = [];
  for (const [typeName, handler] of registry) {
    attemptedTypes.push(typeName);
    try {
      return await handler(db, companyId, contactId, txnId);
    } catch (error) {
      logger.debug(
        { companyId, contactId, txnId, typeName, error },
        "transaction lookup type probe failed; continuing",
      );
      // Continue to next type. See NOTE in function-level JSDoc about why
      // this catch is currently too broad — error discrimination is deferred.
    }
  }

  throw new TransactionNotFoundError(txnId, platform, attemptedTypes);
}
