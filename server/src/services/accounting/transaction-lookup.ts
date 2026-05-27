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
import { HttpResponseError } from "./http-error.js";
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

interface QboJournalEntryLine {
  DetailType?: string;
  JournalEntryLineDetail?: {
    PostingType?: "Debit" | "Credit";
    AccountRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboJournalEntryFull {
  Id: string;
  SyncToken: string;
  Line?: QboJournalEntryLine[];
  [key: string]: unknown;
}

interface QboDepositLine {
  DetailType?: string;
  DepositLineDetail?: {
    AccountRef?: { value?: string };
    PaymentMethodRef?: { value?: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboDepositFull {
  Id: string;
  SyncToken: string;
  DepositToAccountRef?: { value?: string };
  Line?: QboDepositLine[];
  [key: string]: unknown;
}

interface QboBillPaymentLine {
  // BillPayment lines contain LinkedTxn references (to bills being paid),
  // not direct AccountRefs. We model the structure but don't extract from it.
  Amount?: number;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  [key: string]: unknown;
}

interface QboBillPaymentFull {
  Id: string;
  SyncToken: string;
  PayType?: "Check" | "CreditCard" | string;
  VendorRef?: { value?: string };
  TotalAmt?: number;
  CheckPayment?: {
    BankAccountRef?: { value?: string };
    PrintStatus?: string;
    [key: string]: unknown;
  };
  CreditCardPayment?: {
    CCAccountRef?: { value?: string };
    [key: string]: unknown;
  };
  Line?: QboBillPaymentLine[];
  [key: string]: unknown;
}

interface QboPaymentLine {
  // Payment lines (like BillPayment lines) contain LinkedTxn references —
  // here pointing to the Invoices being paid. No per-line AccountRef.
  Amount?: number;
  LinkedTxn?: Array<{ TxnId?: string; TxnType?: string }>;
  [key: string]: unknown;
}

interface QboPaymentFull {
  Id: string;
  SyncToken: string;
  CustomerRef?: { value?: string };
  ARAccountRef?: { value?: string };
  DepositToAccountRef?: { value?: string };
  PaymentMethodRef?: { value?: string };
  TotalAmt?: number;
  Line?: QboPaymentLine[];
  [key: string]: unknown;
}

interface QboInvoiceLine {
  // Invoice lines come in multiple DetailType variants:
  //   - SalesItemLineDetail: actual sales line (this is what we extract from)
  //   - SubTotalLineDetail: subtotal/group marker (filtered out)
  //   - DescriptionOnlyLineDetail, DiscountLineDetail, etc.
  // Only SalesItemLineDetail carries the ItemAccountRef we need.
  DetailType?: string;
  Amount?: number;
  SalesItemLineDetail?: {
    ItemRef?: { value?: string; name?: string };
    ItemAccountRef?: { value?: string; name?: string };
    UnitPrice?: number;
    Qty?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface QboInvoiceFull {
  Id: string;
  SyncToken: string;
  CustomerRef?: { value?: string };
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  Line?: QboInvoiceLine[];
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

interface XeroInvoiceLineItem {
  LineItemID?: string;
  AccountCode?: string;
  Description?: string;
  Quantity?: number;
  UnitAmount?: number;
  [key: string]: unknown;
}

interface XeroInvoiceOrBillFull {
  // Xero serves both ACCREC (sales Invoice) and ACCPAY (purchase Bill) from
  // the same /Invoices/{id} endpoint with a Type discriminator. See WIP doc
  // Decision 4 REVISED note (2026-05-27 commit fb13f98c) for the rationale.
  InvoiceID: string;
  Type?: "ACCREC" | "ACCPAY" | string;
  InvoiceNumber?: string;
  LineItems?: XeroInvoiceLineItem[];
  [key: string]: unknown;
}

interface XeroManualJournalLine {
  // Xero ManualJournalLines wrap a per-line accountCode + signed lineAmount
  // (positive = debit, negative = credit per Xero convention).
  LineAmount?: number;
  AccountCode?: string;
  Description?: string;
  [key: string]: unknown;
}

interface XeroManualJournalFull {
  ManualJournalID: string;
  Narration?: string;
  Status?: string;
  JournalLines?: XeroManualJournalLine[];
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

async function fetchQboJournalEntry(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ JournalEntry: QboJournalEntryFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/journalentry/${txnId}`,
  );
  const journalEntry = response.JournalEntry;
  if (!journalEntry) {
    throw new Error(`QBO JournalEntry ${txnId} response missing JournalEntry field`);
  }
  // JournalEntries are multi-line by nature: each line has its own AccountRef
  // (typically one Debit and one Credit, but potentially more). There is no
  // single canonical "previous account" for a journal — we capture the FIRST
  // line's AccountRef here for consistency with the Purchase/Bill handlers,
  // but callers needing per-line account fidelity should consume the `raw`
  // field directly. This is documented in the dispatcher contract: the
  // previousAccountRef return value is a hint, not a source of truth for
  // multi-line transactions.
  const firstLine = journalEntry.Line?.[0];
  const previousAccountRef =
    firstLine?.JournalEntryLineDetail?.AccountRef?.value ?? null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "JournalEntry",
    previousAccountRef,
    raw: journalEntry,
  };
}

async function fetchQboDeposit(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ Deposit: QboDepositFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/deposit/${txnId}`,
  );
  const deposit = response.Deposit;
  if (!deposit) {
    throw new Error(`QBO Deposit ${txnId} response missing Deposit field`);
  }
  // Deposit has TWO account-ref locations:
  //   - DepositToAccountRef (top-level): the bank account RECEIVING the funds
  //   - Line[].DepositLineDetail.AccountRef (per-line): the SOURCE account
  //     being categorized (typically a customer's pending payment account or
  //     a sales account)
  // For audit-trail purposes — which is what previousAccountRef exists for —
  // we capture the FIRST LINE's source AccountRef. Re-categorization
  // workflows act on the source side, not the destination bank account.
  // Multi-line approximation caveat applies (same as Bill, JournalEntry,
  // Purchase): callers needing per-line fidelity should consume the raw
  // field directly.
  const firstLine = deposit.Line?.[0];
  const previousAccountRef =
    firstLine?.DepositLineDetail?.AccountRef?.value ?? null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "Deposit",
    previousAccountRef,
    raw: deposit,
  };
}

async function fetchQboBillPayment(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ BillPayment: QboBillPaymentFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/billpayment/${txnId}`,
  );
  const billPayment = response.BillPayment;
  if (!billPayment) {
    throw new Error(`QBO BillPayment ${txnId} response missing BillPayment field`);
  }
  // BillPayment is structurally DIFFERENT from Purchase / Bill / JournalEntry /
  // Deposit. Lines contain only LinkedTxn references (to the bills being paid),
  // NOT account refs. The relevant account ref lives at the TOP LEVEL,
  // discriminated by PayType:
  //   - PayType "Check"      → CheckPayment.BankAccountRef.value
  //   - PayType "CreditCard" → CreditCardPayment.CCAccountRef.value
  //   - Anything else        → null (defensive)
  //
  // We capture the payment-source account as previousAccountRef. Reasoning:
  // re-categorization workflows on a BillPayment act on the source side — a
  // user correcting a bill payment is fixing which account paid the bill,
  // not the bill itself (the bills being paid are referenced via LinkedTxn
  // and are themselves separate transactions that would be edited via their
  // own /bill/{id} endpoint).
  let previousAccountRef: string | null = null;
  if (billPayment.PayType === "Check") {
    previousAccountRef = billPayment.CheckPayment?.BankAccountRef?.value ?? null;
  } else if (billPayment.PayType === "CreditCard") {
    previousAccountRef = billPayment.CreditCardPayment?.CCAccountRef?.value ?? null;
  }
  return {
    txnId,
    platform: "quickbooks",
    txnType: "BillPayment",
    previousAccountRef,
    raw: billPayment,
  };
}

async function fetchQboPayment(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ Payment: QboPaymentFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/payment/${txnId}`,
  );
  const payment = response.Payment;
  if (!payment) {
    throw new Error(`QBO Payment ${txnId} response missing Payment field`);
  }
  // Payment is the customer-side counterpart to BillPayment. Like
  // BillPayment, the lines contain LinkedTxn references (to Invoices being
  // paid) rather than per-line AccountRefs. The relevant account refs are
  // both top-level:
  //   - DepositToAccountRef: where the money LANDED (bank account, or
  //     "Undeposited Funds" by default)
  //   - ARAccountRef: the AR account the payment REDUCES (typically
  //     "Accounts Receivable")
  //
  // We capture DepositToAccountRef as previousAccountRef. Reasoning:
  // re-categorization workflows on a Payment act on the destination side —
  // a user fixing a Payment is correcting which bank account it landed in
  // (e.g., wrong account selected, or moving from Undeposited Funds to
  // Checking). The ARAccountRef rarely changes in practice.
  //
  // Fallback: if DepositToAccountRef is missing (some QBO Payments don't
  // populate it when defaulting to Undeposited Funds), fall back to
  // ARAccountRef so audit trails still have something useful. If both are
  // missing, return null.
  const previousAccountRef =
    payment.DepositToAccountRef?.value ??
    payment.ARAccountRef?.value ??
    null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "Payment",
    previousAccountRef,
    raw: payment,
  };
}

async function fetchQboInvoice(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await qboRequest<{ Invoice: QboInvoiceFull }>(
    db,
    companyId,
    contactId,
    "GET",
    `/invoice/${txnId}`,
  );
  const invoice = response.Invoice;
  if (!invoice) {
    throw new Error(`QBO Invoice ${txnId} response missing Invoice field`);
  }
  // QBO Invoice lines mix multiple DetailType variants — most commonly
  // SalesItemLineDetail (actual sales) and SubTotalLineDetail (subtotal
  // markers). We need ONLY the first SalesItemLineDetail line, because:
  //   - SubTotalLineDetail lines have no account information
  //   - DescriptionOnlyLineDetail, DiscountLineDetail also lack ItemAccountRef
  //
  // SalesItemLineDetail itself contains TWO refs we could use:
  //   - ItemRef: pointer to the QBO Item (e.g., "Gardening")
  //   - ItemAccountRef: the income account the Item resolves to (populated
  //     on GET responses; e.g., "Landscaping Services" → account id 45)
  //
  // We use ItemAccountRef because previousAccountRef is supposed to be an
  // account reference — ItemRef is one step removed (it's the Item, not
  // the account). The Invoice GET response conveniently resolves this for
  // us by populating ItemAccountRef.
  //
  // Multi-line invoices: first sales line approximation, consistent with
  // the pattern across other multi-line types in this dispatcher. Callers
  // needing per-line fidelity should consume the raw field.
  const firstSalesLine = invoice.Line?.find(
    (line) => line.DetailType === "SalesItemLineDetail",
  );
  const previousAccountRef =
    firstSalesLine?.SalesItemLineDetail?.ItemAccountRef?.value ?? null;
  return {
    txnId,
    platform: "quickbooks",
    txnType: "Invoice",
    previousAccountRef,
    raw: invoice,
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

async function fetchXeroInvoiceOrBill(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await xeroRequest<{ Invoices?: XeroInvoiceOrBillFull[] }>(
    db,
    companyId,
    contactId,
    "GET",
    `/Invoices/${txnId}`,
  );
  const invoice = response.Invoices?.[0];
  if (!invoice) {
    throw new Error(`Xero Invoice/Bill ${txnId} response missing Invoices array or first entry`);
  }
  // Xero treats ACCREC (sales Invoice) and ACCPAY (purchase Bill) as the same
  // resource type, served by the same endpoint with a Type field discriminator.
  // The dispatcher contract requires us to report which one it actually is:
  //   - Type "ACCREC" → txnType "Invoice"
  //   - Type "ACCPAY" → txnType "Bill"
  //   - Anything else → txnType "Invoice" defensively (Invoice is the more
  //     common case; the Type field has historically been stable so this
  //     fallback should never trigger in practice)
  //
  // See WIP doc Decision 4 REVISED note (commit fb13f98c) for the full
  // rationale and Tenet #16 invocation.
  //
  // previousAccountRef: first LineItem's AccountCode. Like other multi-line
  // transactions in this dispatcher, this is an approximation — callers
  // needing per-line account fidelity should consume the raw field.
  let resolvedTxnType: string;
  if (invoice.Type === "ACCPAY") {
    resolvedTxnType = "Bill";
  } else {
    resolvedTxnType = "Invoice";
  }
  const firstLine = invoice.LineItems?.[0];
  const previousAccountRef = firstLine?.AccountCode ?? null;
  return {
    txnId,
    platform: "xero",
    txnType: resolvedTxnType,
    previousAccountRef,
    raw: invoice,
  };
}

async function fetchXeroManualJournal(
  db: Db,
  companyId: string,
  contactId: string | null,
  txnId: string,
): Promise<TransactionLookupResult> {
  const response = await xeroRequest<{ ManualJournals?: XeroManualJournalFull[] }>(
    db,
    companyId,
    contactId,
    "GET",
    `/ManualJournals/${txnId}`,
  );
  const journal = response.ManualJournals?.[0];
  if (!journal) {
    throw new Error(`Xero ManualJournal ${txnId} response missing ManualJournals array or first entry`);
  }
  // ManualJournals are multi-line by nature (matched Debit/Credit pairs).
  // Like QBO JournalEntry, there is no single canonical "previous account"
  // for a journal. We capture the FIRST line's AccountCode for consistency
  // with the other handlers; callers needing per-line account fidelity
  // should consume the raw field directly.
  const firstLine = journal.JournalLines?.[0];
  const previousAccountRef = firstLine?.AccountCode ?? null;
  return {
    txnId,
    platform: "xero",
    txnType: "ManualJournal",
    previousAccountRef,
    raw: journal,
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
  ["JournalEntry", fetchQboJournalEntry],
  ["Deposit", fetchQboDeposit],
  ["BillPayment", fetchQboBillPayment],
  ["Payment", fetchQboPayment],
  ["Invoice", fetchQboInvoice],
  // QBO type coverage complete — 7 of 7 planned QBO types registered.
]);

const XERO_TYPE_REGISTRY: ReadonlyMap<string, FetchHandler> = new Map([
  ["BankTransaction", fetchXeroBankTransaction],
  ["Invoice", fetchXeroInvoiceOrBill],
  ["Bill", fetchXeroInvoiceOrBill],
  ["ManualJournal", fetchXeroManualJournal],
  // Xero type coverage complete — 3 handler functions covering 4 type keys.
]);

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

/**
 * Look up a transaction by ID across the platform connected for this contact.
 *
 * Optional hintedType short-circuits the multi-type probe loop — callers who
 * already know the type (e.g., updateTransactionCategory in
 * transaction-write.ts passing hintedType through) can pass it to avoid
 * wasted API calls. Without a hint, the dispatcher tries each registered
 * type for the platform until one succeeds.
 *
 * Throws TransactionNotFoundError if no registered handler returns a result.
 * Callers should route this to the
 * accounting.transaction.category_with_unknown_previous approval flow per
 * Phase 4c.4 dispatcher.
 *
 * Multi-type probing semantics (Phase 2 update, 2026-05-27): only 404
 * responses (HttpResponseError.isNotFound) cause the loop to continue to
 * the next registered type. Any other error — auth failure, 5xx, network
 * error, malformed response — is rethrown immediately. This is the strict
 * discriminator gap closed by Phase 2: previously the catch was
 * unconditional, which masked genuine upstream failures as "type didn't
 * match". qboRequest and xeroRequest now throw HttpResponseError with a
 * structured .status property; the dispatcher uses .isNotFound for the
 * continue/rethrow decision.
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

  // Multi-type probing: try each registered type; only treat a 404
  // (HttpResponseError.isNotFound) as "wrong type, try next". Any other
  // error (auth failure, 5xx, network error, malformed response, etc.)
  // is genuine and must propagate up — silently swallowing it could cause
  // the dispatcher to throw TransactionNotFoundError when the real cause
  // is something the caller needs to know about.
  //
  // Decision 4 Phase 2 tightening (commit pending Session 4 2026-05-27):
  // previously this catch was unconditional, which was safe-but-loose
  // because all callers passed hintedType (skipping the loop). Now that
  // QBO Bill is registered alongside Purchase, the loop actually iterates
  // and the error discrimination matters.
  const attemptedTypes: string[] = [];
  for (const [typeName, handler] of registry) {
    attemptedTypes.push(typeName);
    try {
      return await handler(db, companyId, contactId, txnId);
    } catch (error) {
      if (error instanceof HttpResponseError && error.isNotFound) {
        logger.debug(
          { companyId, contactId, txnId, typeName, status: error.status },
          "transaction lookup: 404 on type probe, trying next type",
        );
        continue;
      }
      // Any non-404 error is rethrown — it's not "wrong type, try next",
      // it's a genuine upstream failure the caller needs to see.
      throw error;
    }
  }

  throw new TransactionNotFoundError(txnId, platform, attemptedTypes);
}
