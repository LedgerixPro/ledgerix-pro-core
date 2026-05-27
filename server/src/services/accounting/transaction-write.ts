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

const QBO_WRITE_REGISTRY: ReadonlyMap<string, WriteHandler> = new Map([
  // Decision 5 IN-scope handlers will register here:
  // ["Purchase", updateQboPurchaseAccount],
  // ["Bill", updateQboBillAccount],
  // ["Deposit", updateQboDepositAccount],
]);

const XERO_WRITE_REGISTRY: ReadonlyMap<string, WriteHandler> = new Map([
  // Decision 5 IN-scope handlers will register here:
  // ["BankTransaction", updateXeroBankTransactionAccount],
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
