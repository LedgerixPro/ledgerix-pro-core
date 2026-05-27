// Phase 4c.5 Decision 5 — write-side dispatcher for transaction category updates.
//
// The write-side counterpart to Decision 4's read dispatcher
// (getTransactionById). Where the read side covers all 11 transaction types,
// this write side covers 6 of those types — the asymmetry is by design and
// matches QBO/Xero API reality.
//
// IN scope (6 types, will be registered as handlers ship):
//   - QBO Purchase, Bill, Deposit
//   - Xero BankTransaction, Invoice (ACCREC), Bill (ACCPAY) — Invoice + Bill
//     share a write handler per the same shared-endpoint pattern Decision 4
//     uses for reads.
//
// EXCLUDED (5 types, throw TransactionTypeNotCategorizableError):
//   - QBO BillPayment, Payment, Invoice — fundamentally not category updates
//   - QBO JournalEntry, Xero ManualJournal — multi-line journal write semantics
//     deferred to Q5 (multi-line Debit/Credit balance preservation)
//
// See docs/wip/phase-4c-5-write-endpoints-and-admin-api.md Decision 5 for
// the locked interface contract and the full reasoning.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { qboRequest } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import {
  getTransactionById,
  type TransactionLookupResult,
} from "./transaction-lookup.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface UpdateTransactionCategoryResult {
  platform: "quickbooks" | "xero";
  txnType: string;
  txnId: string;
  previousAccountRef: string | null;
  newAccountRef: string;
}

/**
 * Thrown when the resolved transaction type is not in the write registry.
 * Distinct from TransactionNotFoundError (read-side, thrown by
 * getTransactionById when no platform GET succeeds).
 *
 * This is the typed signal that the caller should map to HTTP 400.
 */
export class TransactionTypeNotCategorizableError extends Error {
  constructor(
    public readonly platform: "quickbooks" | "xero",
    public readonly txnType: string,
    public readonly txnId: string,
  ) {
    super(
      `Transaction type ${platform}.${txnType} (txnId=${txnId}) does not support category updates. ` +
        `See Decision 5 in docs/wip/phase-4c-5-write-endpoints-and-admin-api.md for the supported-type list.`,
    );
    this.name = "TransactionTypeNotCategorizableError";
  }
}

// ---------------------------------------------------------------------------
// Write handler contract
// ---------------------------------------------------------------------------

/**
 * Per-type write handler. Takes the lookup result from the read side
 * (containing the full transaction in lookup.raw) plus the new account ref
 * to set. Mutates the raw object's relevant line/field and POSTs the
 * update to the platform.
 *
 * Returns void on success. Throws on platform-write failure (the platform
 * client throws HttpResponseError for non-OK responses, which propagates).
 */
export type WriteHandler = (
  db: Db,
  companyId: string,
  contactId: string | null,
  lookup: TransactionLookupResult,
  newAccountRef: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Per-platform write registries — populated incrementally per Path Y.
// Each handler ships in its own commit; this foundation commit registers none.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-type write handlers
// ---------------------------------------------------------------------------

// Minimal type for mutation — mirrors the QboPurchaseFull shape used by the
// read-side handler. We only need to safely access Line[0] and mutate its
// AccountBasedExpenseLineDetail.AccountRef. Defined locally rather than
// imported from transaction-lookup.ts because that module keeps its full
// type definitions internal.
// Shared line shape for QBO entities that use AccountBasedExpenseLineDetail:
// Purchase, Bill. Both have the same Line[].AccountBasedExpenseLineDetail
// structure, so they share both the type and the per-line mutation logic.
// Only the write endpoint differs (/purchase?operation=update vs
// /bill?operation=update).
interface QboAccountBasedExpenseLine {
  AccountBasedExpenseLineDetail?: {
    AccountRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboAccountBasedExpenseTxnForWrite {
  Id: string;
  SyncToken: string;
  Line?: QboAccountBasedExpenseLine[];
  [key: string]: unknown;
}

/**
 * QBO Purchase write handler. Mutates the first line's
 * AccountBasedExpenseLineDetail.AccountRef and POSTs the full transaction
 * back to /purchase?operation=update.
 *
 * QBO update semantics: sparse updates aren't supported — must POST the
 * entire transaction object back. The lookup.raw field from getTransactionById
 * contains exactly that object, which makes the mutate-and-resend pattern
 * straightforward.
 *
 * Multi-line caveat: only the first line's AccountRef is updated. This is
 * consistent with the read-side previousAccountRef capture (also first line).
 * Callers needing per-line write fidelity would need a different API surface.
 */
const updateQboPurchaseAccount: WriteHandler = async (
  db,
  companyId,
  contactId,
  lookup,
  newAccountRef,
) => {
  const purchase = lookup.raw as unknown as QboAccountBasedExpenseTxnForWrite;
  const firstLine = purchase.Line?.[0];
  if (!firstLine) {
    throw new Error(
      `QBO Purchase ${lookup.txnId} has no line items to categorize`,
    );
  }
  firstLine.AccountBasedExpenseLineDetail = {
    ...(firstLine.AccountBasedExpenseLineDetail ?? {}),
    AccountRef: { value: newAccountRef },
  };
  await qboRequest(
    db,
    companyId,
    contactId,
    "POST",
    "/purchase?operation=update",
    purchase,
  );
};

/**
 * QBO Bill write handler. Structurally identical to Purchase — both use
 * Line[].AccountBasedExpenseLineDetail.AccountRef. The only difference is
 * the write endpoint (/bill?operation=update instead of /purchase).
 *
 * Verified against QBO API: Bill response includes Line array of
 * AccountBasedExpenseLineDetail entries with AccountRef.value pointing to
 * the expense account. Full-transaction POST required for updates per
 * Intuit's recommendation (sparse updates inconsistent across entity types).
 *
 * Multi-line caveat: same as Purchase — first line's AccountRef is updated;
 * subsequent lines retain their existing values. Consistent with the
 * read-side previousAccountRef capture pattern.
 */
const updateQboBillAccount: WriteHandler = async (
  db,
  companyId,
  contactId,
  lookup,
  newAccountRef,
) => {
  const bill = lookup.raw as unknown as QboAccountBasedExpenseTxnForWrite;
  const firstLine = bill.Line?.[0];
  if (!firstLine) {
    throw new Error(
      `QBO Bill ${lookup.txnId} has no line items to categorize`,
    );
  }
  firstLine.AccountBasedExpenseLineDetail = {
    ...(firstLine.AccountBasedExpenseLineDetail ?? {}),
    AccountRef: { value: newAccountRef },
  };
  await qboRequest(
    db,
    companyId,
    contactId,
    "POST",
    "/bill?operation=update",
    bill,
  );
};

// Line shape for QBO Deposit. UNLIKE Purchase/Bill (which use
// AccountBasedExpenseLineDetail), Deposit lines use DepositLineDetail —
// a different sub-object with different sibling fields (PaymentMethodRef,
// CheckNum, TxnType, etc. — all of which must survive the AccountRef
// mutation).
//
// Deposit has TWO account refs in its full shape:
//   - DepositToAccountRef (top-level): destination bank account
//   - Line[N].DepositLineDetail.AccountRef (per-line): source account
//
// The handler mutates ONLY the per-line source AccountRef. The destination
// DepositToAccountRef is NOT modified — re-categorization on a Deposit
// means correcting where the funds came from, not where they landed.
// Matches the read-side previousAccountRef capture pattern.
interface QboDepositLineForWrite {
  DepositLineDetail?: {
    AccountRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboDepositRawForWrite {
  Id: string;
  SyncToken: string;
  DepositToAccountRef?: { value?: string };
  Line?: QboDepositLineForWrite[];
  [key: string]: unknown;
}

/**
 * QBO Deposit write handler. Mutates the first line's
 * DepositLineDetail.AccountRef (the SOURCE account) and POSTs the full
 * transaction back to /deposit?operation=update.
 *
 * IMPORTANT: top-level DepositToAccountRef is NOT modified. That field
 * represents the destination bank account; the categorization decision is
 * about the source account in DepositLineDetail. This matches the
 * read-side handler's previousAccountRef capture (which also reads from
 * DepositLineDetail.AccountRef, not DepositToAccountRef).
 *
 * Multi-line caveat: first line only, consistent with other multi-line
 * write handlers. Deposit can legitimately have multiple lines (one per
 * incoming payment source); selecting only the first is an approximation
 * for v1. Callers needing per-line write fidelity would need a different
 * API surface (e.g., POST /transactions/:txnId/line/:lineIdx/category).
 *
 * Fields preserved during mutation via spread-merge: PaymentMethodRef,
 * CheckNum, TxnType, Entity, and any other DepositLineDetail sub-fields
 * the read-side response surfaces.
 */
const updateQboDepositAccount: WriteHandler = async (
  db,
  companyId,
  contactId,
  lookup,
  newAccountRef,
) => {
  const deposit = lookup.raw as unknown as QboDepositRawForWrite;
  const firstLine = deposit.Line?.[0];
  if (!firstLine) {
    throw new Error(
      `QBO Deposit ${lookup.txnId} has no line items to categorize`,
    );
  }
  firstLine.DepositLineDetail = {
    ...(firstLine.DepositLineDetail ?? {}),
    AccountRef: { value: newAccountRef },
  };
  await qboRequest(
    db,
    companyId,
    contactId,
    "POST",
    "/deposit?operation=update",
    deposit,
  );
};

const QBO_WRITE_REGISTRY: ReadonlyMap<string, WriteHandler> = new Map([
  ["Purchase", updateQboPurchaseAccount],
  ["Bill", updateQboBillAccount],
  ["Deposit", updateQboDepositAccount],
  // QBO write registry complete — 3 of 3 planned QBO handlers registered.
]);

// ---------------------------------------------------------------------------
// Xero per-type write handlers
// ---------------------------------------------------------------------------

// Line shape for Xero BankTransaction. UNLIKE QBO (which wraps account refs
// in { value: string } objects under nested *LineDetail sub-objects), Xero
// LineItems store AccountCode as a plain string directly on the LineItem.
// Other LineItem fields that must survive AccountRef mutation: Description,
// Quantity, UnitAmount, ItemCode, TaxType, TaxAmount, Tracking, LineAmount,
// DiscountRate, etc. The spread-merge pattern preserves all of these.
interface XeroBankTransactionLineForWrite {
  AccountCode?: string;
  [key: string]: unknown;
}

interface XeroBankTransactionRawForWrite {
  BankTransactionID: string;
  // Xero BankTransaction full shape includes Type (SPEND/RECEIVE), Status,
  // Contact, BankAccount, LineItems, etc. We only need LineItems[] for the
  // mutation; other fields are passed through unchanged.
  LineItems?: XeroBankTransactionLineForWrite[];
  [key: string]: unknown;
}

/**
 * Xero BankTransaction write handler. Mutates the first LineItem's
 * AccountCode and POSTs the full transaction back to /BankTransactions.
 *
 * Xero update semantics differ from QBO:
 *   - POST /BankTransactions serves BOTH create and update — Xero detects
 *     the update case by presence of BankTransactionID in the body
 *   - No ?operation=update query param needed
 *   - Body wraps the transaction in a BankTransactions array (Xero idiom
 *     for batch-capable endpoints — single-item case still requires the
 *     array wrapper)
 *
 * AccountCode is a plain string (not a wrapper object), so the mutation
 * is simpler than QBO's { value: ... } pattern: direct assignment of the
 * new code string. Spread-merge still used for defensive consistency
 * with the QBO handlers and to preserve any future LineItem fields
 * not modeled in XeroBankTransactionLineForWrite.
 *
 * Multi-line caveat: first line only, consistent with all other Decision 5
 * handlers. Xero BankTransactions typically have one LineItem (one per
 * imported bank feed entry); multi-line cases are rare in practice.
 */
const updateXeroBankTransactionAccount: WriteHandler = async (
  db,
  companyId,
  contactId,
  lookup,
  newAccountCode,
) => {
  const txn = lookup.raw as unknown as XeroBankTransactionRawForWrite;
  const firstLine = txn.LineItems?.[0];
  if (!firstLine) {
    throw new Error(
      `Xero BankTransaction ${lookup.txnId} has no line items to categorize`,
    );
  }
  txn.LineItems![0] = {
    ...firstLine,
    AccountCode: newAccountCode,
  };
  await xeroRequest(
    db,
    companyId,
    contactId,
    "POST",
    "/BankTransactions",
    { BankTransactions: [txn] },
  );
};

const XERO_WRITE_REGISTRY: ReadonlyMap<string, WriteHandler> = new Map([
  ["BankTransaction", updateXeroBankTransactionAccount],
  // Decision 5 IN-scope handlers still to add:
  // ["Invoice", updateXeroInvoiceOrBillAccount],
  // ["Bill", updateXeroInvoiceOrBillAccount],
  // ["ManualJournal", deferred to Q5]
]);

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Update the account categorization on a transaction. Public-facing entry
 * point for POST /transactions/:txnId/category and any other category-update
 * caller (e.g., bookkeeping agents).
 *
 * Steps:
 *   1. Call getTransactionById to fetch the transaction + capture
 *      previousAccountRef for audit trail.
 *   2. Look up the write handler in QBO_WRITE_REGISTRY or XERO_WRITE_REGISTRY
 *      based on the resolved platform.
 *   3. If no handler registered for this type → throw
 *      TransactionTypeNotCategorizableError. The endpoint maps this to HTTP 400.
 *   4. Else → call the handler. Handler mutates lookup.raw + POSTs update.
 *   5. Return result with the captured previousAccountRef + the passed-through
 *      newAccountRef.
 *
 * Throws:
 *   - TransactionNotFoundError (from getTransactionById) — no platform GET
 *     succeeded. Caller maps to HTTP 202 + approval row creation.
 *   - TransactionTypeNotCategorizableError — type resolved but not supported
 *     for writes. Caller maps to HTTP 400.
 *   - HttpResponseError (from platform client) — platform write failed
 *     (auth, 5xx, etc.). Caller maps to HTTP 502.
 *   - Other Error subclasses — unexpected platform / db / programmer error.
 *     Caller maps to HTTP 500.
 *
 * See Decision 5 in docs/wip/phase-4c-5-write-endpoints-and-admin-api.md
 * for the full locked behavior.
 */
export async function updateTransactionCategory(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
  newAccountRef: string,
): Promise<UpdateTransactionCategoryResult> {
  // Step 1: read-side lookup. previousAccountRef captured here for audit.
  const lookup = await getTransactionById(db, companyId, contactId, txnId);

  // Step 2: dispatch to the right platform's write registry.
  const registry =
    lookup.platform === "quickbooks"
      ? QBO_WRITE_REGISTRY
      : XERO_WRITE_REGISTRY;
  const handler = registry.get(lookup.txnType);

  // Step 3: if not in write registry, throw the typed exclusion error.
  if (!handler) {
    logger.info(
      {
        companyId,
        contactId,
        txnId,
        platform: lookup.platform,
        txnType: lookup.txnType,
      },
      "Transaction type not in write registry — throwing TransactionTypeNotCategorizableError",
    );
    throw new TransactionTypeNotCategorizableError(
      lookup.platform,
      lookup.txnType,
      txnId,
    );
  }

  // Step 4: execute write. Handler mutates lookup.raw + POSTs.
  await handler(db, companyId, contactId, lookup, newAccountRef);

  // Step 5: return result with previousAccountRef from the lookup +
  // newAccountRef as the caller passed it.
  logger.info(
    {
      companyId,
      contactId,
      txnId,
      platform: lookup.platform,
      txnType: lookup.txnType,
      previousAccountRef: lookup.previousAccountRef,
      newAccountRef,
    },
    "Transaction category updated",
  );
  return {
    platform: lookup.platform,
    txnType: lookup.txnType,
    txnId,
    previousAccountRef: lookup.previousAccountRef,
    newAccountRef,
  };
}

// ---------------------------------------------------------------------------
// Internal exports — for use by per-type handler modules and tests only.
// Not part of the public Decision 5 contract.
// ---------------------------------------------------------------------------

// Registries are NOT exported. Handler modules (added per Path Y) will
// register their handlers by importing this module and mutating the
// registries — but for that to work, the registries need to be exported
// as mutable Maps OR the registries need a register() function.
//
// For the foundation commit: keep registries as private const ReadonlyMaps.
// The per-type commits will switch them to mutable Maps with register()
// helpers as they begin populating. This avoids a fake-mutable type for the
// foundation when there are no handlers yet.
