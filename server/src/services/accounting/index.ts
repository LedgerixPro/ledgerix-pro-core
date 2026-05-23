import { and, eq, isNull } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { qboRequest, getQboRealmId } from "./qbo-client.js";
import { xeroRequest } from "./xero-client.js";
import { logger } from "../../middleware/logger.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Transaction {
  id: string;
  type: string;
  date: string;
  amount: number;
  vendor: string | null;
  accountRef: string | null;
  description: string | null;
  // Whether the transaction has been reconciled against a bank-statement line.
  // Populated from Xero's IsReconciled field. Null for QBO (no equivalent field
  // on Purchase/Deposit/Transfer) and for any Xero response that omits it.
  isReconciled: boolean | null;
  // Status string from the source platform (e.g. Xero AUTHORISED / DELETED /
  // VOIDED). Null when the source doesn't expose a status concept for the type.
  status: string | null;
}

// Open-bill snapshot from QBO/Xero. daysDue is signed: positive = days until due,
// negative = days overdue. Computed at fetch time relative to UTC midnight.
export interface Bill {
  id: string;
  vendorName: string;
  amount: number;
  balance: number;
  dueDate: string;
  daysDue: number;
}

interface QboBill {
  Id: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  VendorRef?: { value: string; name?: string };
}

interface XeroBill {
  InvoiceID: string;
  Type?: string;
  DueDate?: string;
  Total?: number;
  AmountDue?: number;
  Contact?: { Name?: string };
}

function computeDaysDue(dueDate: string | undefined): number {
  if (!dueDate) return 0;
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return 0;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  due.setUTCHours(0, 0, 0, 0);
  return Math.floor((due.getTime() - today.getTime()) / 86_400_000);
}

interface QboRef {
  value: string;
  name?: string;
}

interface QboPurchase {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  EntityRef?: QboRef;
  AccountRef?: QboRef;
  PrivateNote?: string;
}

interface QboDeposit {
  Id: string;
  TxnDate: string;
  TotalAmt: number;
  DepositToAccountRef?: QboRef;
  PrivateNote?: string;
}

interface QboTransfer {
  Id: string;
  TxnDate: string;
  Amount: number;
  FromAccountRef?: QboRef;
  ToAccountRef?: QboRef;
  PrivateNote?: string;
}

interface QboQueryResponse<K extends string, T> {
  QueryResponse: { [key in K]?: T[] } & { startPosition?: number; maxResults?: number };
}

interface XeroBankTransaction {
  BankTransactionID: string;
  Type: string;
  Date: string;
  DateString?: string;
  Total: number;
  Reference?: string;
  Contact?: { Name?: string };
  BankAccount?: { Name?: string };
  LineItems?: Array<{ Description?: string }>;
  IsReconciled?: boolean;
  Status?: string;
}

// Full QBO Purchase shape for read-modify-write categorization
interface QboPurchaseLineDetail {
  AccountRef?: QboRef;
  [key: string]: unknown;
}

interface QboPurchaseLine {
  Id?: string;
  DetailType?: string;
  Amount?: number;
  AccountBasedExpenseLineDetail?: QboPurchaseLineDetail;
  [key: string]: unknown;
}

interface QboPurchaseFull {
  Id: string;
  SyncToken: string;
  Line?: QboPurchaseLine[];
  [key: string]: unknown;
}

// Full Xero BankTransaction shape for read-modify-write categorization
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
// Helpers
// ---------------------------------------------------------------------------

// QBO query language quotes literals with single quotes — strip any single
// quotes from caller-supplied dates to keep the WHERE clause well-formed
function safeQboTimestamp(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date for QBO filter: ${s}`);
  return d.toISOString();
}

// Xero filter syntax expects a DateTime(y,m,d) literal
function xeroDateTimeLiteral(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date for Xero filter: ${s}`);
  return `DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()})`;
}

function qboQueryUrl(query: string): string {
  return `/query?${new URLSearchParams({ query })}`;
}

function contactFilter(contactId: string | null) {
  return contactId === null
    ? isNull(accountingConnections.contactId)
    : eq(accountingConnections.contactId, contactId);
}

// ---------------------------------------------------------------------------
// QBO
// ---------------------------------------------------------------------------

export const qbo = {
  async getCompanyInfo(db: Db, companyId: string, contactId: string | null) {
    const realmId = await getQboRealmId(db, companyId, contactId);
    return qboRequest(db, companyId, contactId, "GET", `/companyinfo/${realmId}`);
  },

  async getAccounts(db: Db, companyId: string, contactId: string | null) {
    return qboRequest(db, companyId, contactId, "GET", qboQueryUrl("SELECT * FROM Account"));
  },

  async getProfitAndLoss(db: Db, companyId: string, contactId: string | null, startDate: string, endDate: string) {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    return qboRequest(db, companyId, contactId, "GET", `/reports/ProfitAndLoss?${params}`);
  },

  async getBalanceSheet(db: Db, companyId: string, contactId: string | null, asOfDate: string) {
    const params = new URLSearchParams({ as_of_date: asOfDate });
    return qboRequest(db, companyId, contactId, "GET", `/reports/BalanceSheet?${params}`);
  },

  // Open bills (Bill entity in QBO) with non-zero balance, ordered by due date.
  // QBO's QBQL does not support > or < comparisons on Balance, so we fetch all
  // and filter client-side.
  async getBills(db: Db, companyId: string, contactId: string | null): Promise<Bill[]> {
    const res = await qboRequest<{ QueryResponse: { Bill?: QboBill[] } }>(
      db,
      companyId,
      contactId,
      "GET",
      `/query?${new URLSearchParams({
        query: "SELECT * FROM Bill ORDER BY DueDate ASC",
      })}`,
    );
    return (res.QueryResponse.Bill ?? [])
      .filter((b) => (b.Balance ?? 0) > 0)
      .map((b) => ({
        id: b.Id,
        vendorName: b.VendorRef?.name ?? "",
        amount: b.TotalAmt ?? 0,
        balance: b.Balance ?? 0,
        dueDate: b.DueDate ?? "",
        daysDue: computeDaysDue(b.DueDate),
      }));
  },

  async getTransactions(db: Db, companyId: string, contactId: string | null, sinceDate: string): Promise<Transaction[]> {
    const ts = safeQboTimestamp(sinceDate);
    const purchaseQ = `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${ts}'`;
    const depositQ = `SELECT * FROM Deposit WHERE MetaData.LastUpdatedTime > '${ts}'`;

    const [purchaseRes, depositRes] = await Promise.all([
      qboRequest<QboQueryResponse<"Purchase", QboPurchase>>(db, companyId, contactId, "GET", qboQueryUrl(purchaseQ)),
      qboRequest<QboQueryResponse<"Deposit", QboDeposit>>(db, companyId, contactId, "GET", qboQueryUrl(depositQ)),
    ]);

    const purchases: Transaction[] = (purchaseRes.QueryResponse.Purchase ?? []).map((p) => ({
      id: p.Id,
      type: "Purchase",
      date: p.TxnDate,
      amount: p.TotalAmt,
      vendor: p.EntityRef?.name ?? null,
      accountRef: p.AccountRef?.name ?? null,
      description: p.PrivateNote ?? null,
      isReconciled: null,
      status: null,
    }));

    const deposits: Transaction[] = (depositRes.QueryResponse.Deposit ?? []).map((d) => ({
      id: d.Id,
      type: "Deposit",
      date: d.TxnDate,
      amount: d.TotalAmt,
      vendor: null,
      accountRef: d.DepositToAccountRef?.name ?? null,
      description: d.PrivateNote ?? null,
      isReconciled: null,
      status: null,
    }));

    return [...purchases, ...deposits];
  },

  async getBankTransactions(db: Db, companyId: string, contactId: string | null, sinceDate: string): Promise<Transaction[]> {
    const ts = safeQboTimestamp(sinceDate);
    const purchaseQ = `SELECT * FROM Purchase WHERE MetaData.LastUpdatedTime > '${ts}'`;
    const depositQ = `SELECT * FROM Deposit WHERE MetaData.LastUpdatedTime > '${ts}'`;
    const transferQ = `SELECT * FROM Transfer WHERE MetaData.LastUpdatedTime > '${ts}'`;

    const [purchaseRes, depositRes, transferRes] = await Promise.all([
      qboRequest<QboQueryResponse<"Purchase", QboPurchase>>(db, companyId, contactId, "GET", qboQueryUrl(purchaseQ)),
      qboRequest<QboQueryResponse<"Deposit", QboDeposit>>(db, companyId, contactId, "GET", qboQueryUrl(depositQ)),
      qboRequest<QboQueryResponse<"Transfer", QboTransfer>>(db, companyId, contactId, "GET", qboQueryUrl(transferQ)),
    ]);

    const purchases: Transaction[] = (purchaseRes.QueryResponse.Purchase ?? []).map((p) => ({
      id: p.Id,
      type: "Purchase",
      date: p.TxnDate,
      amount: p.TotalAmt,
      vendor: p.EntityRef?.name ?? null,
      accountRef: p.AccountRef?.name ?? null,
      description: p.PrivateNote ?? null,
      isReconciled: null,
      status: null,
    }));

    const deposits: Transaction[] = (depositRes.QueryResponse.Deposit ?? []).map((d) => ({
      id: d.Id,
      type: "Deposit",
      date: d.TxnDate,
      amount: d.TotalAmt,
      vendor: null,
      accountRef: d.DepositToAccountRef?.name ?? null,
      description: d.PrivateNote ?? null,
      isReconciled: null,
      status: null,
    }));

    const transfers: Transaction[] = (transferRes.QueryResponse.Transfer ?? []).map((t) => ({
      id: t.Id,
      type: "Transfer",
      date: t.TxnDate,
      amount: t.Amount,
      vendor: null,
      accountRef: t.FromAccountRef?.name ?? null,
      description: t.PrivateNote ?? null,
      isReconciled: null,
      status: null,
    }));

    return [...purchases, ...deposits, ...transfers];
  },

  // Read-modify-write: fetch the Purchase, swap the first line's expense account,
  // send it back. Internally handles SyncToken so callers don't have to.
  async updateTransactionAccount(
    db: Db,
    companyId: string,
    contactId: string | null,
    transactionId: string,
    accountId: string,
  ): Promise<void> {
    const current = await qboRequest<{ Purchase: QboPurchaseFull }>(
      db,
      companyId,
      contactId,
      "GET",
      `/purchase/${transactionId}`,
    );
    const purchase = current.Purchase;
    if (!purchase) {
      throw new Error(`QBO Purchase ${transactionId} not found`);
    }
    const firstLine = purchase.Line?.[0];
    if (!firstLine) {
      throw new Error(`QBO Purchase ${transactionId} has no line items to categorize`);
    }
    firstLine.AccountBasedExpenseLineDetail = {
      ...(firstLine.AccountBasedExpenseLineDetail ?? {}),
      AccountRef: { value: accountId },
    };
    await qboRequest(db, companyId, contactId, "POST", "/purchase?operation=update", purchase);
    logger.info(
      { companyId, contactId, transactionId, accountId },
      "QBO Purchase line account updated",
    );
  },

  // Apply a Payment to an Invoice. QBO server defaults TxnDate to today.
  async applyPaymentToInvoice(
    db: Db,
    companyId: string,
    contactId: string | null,
    invoiceId: string,
    amount: number,
    customerId: string,
  ): Promise<void> {
    const body = {
      CustomerRef: { value: customerId },
      TotalAmt: amount,
      Line: [
        {
          Amount: amount,
          LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }],
        },
      ],
    };
    await qboRequest(db, companyId, contactId, "POST", "/payment", body);
    logger.info(
      { companyId, contactId, invoiceId, amount, customerId },
      "QBO Payment applied to Invoice",
    );
  },

  // Find a Customer by email (preferred) or DisplayName, creating one if neither
  // matches. Email is the more reliable identity field; name fallback handles
  // QBO records imported without an email.
  async findOrCreateCustomer(
    db: Db,
    companyId: string,
    contactId: string | null,
    name: string,
    email: string,
  ): Promise<string> {
    // QBQL uses single-quoted string literals — strip quotes from inputs
    const safeEmail = email.replace(/'/g, "");
    const safeName = name.replace(/'/g, "");

    if (safeEmail) {
      const emailRes = await qboRequest<{ QueryResponse: { Customer?: Array<{ Id: string }> } }>(
        db,
        companyId,
        contactId,
        "GET",
        `/query?${new URLSearchParams({
          query: `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${safeEmail}' MAXRESULTS 1`,
        })}`,
      );
      const found = emailRes?.QueryResponse?.Customer?.[0];
      if (found) {
        logger.info({ companyId, contactId, customerId: found.Id, match: "email" }, "QBO Customer found");
        return found.Id;
      }
    }

    if (safeName) {
      const nameRes = await qboRequest<{ QueryResponse: { Customer?: Array<{ Id: string }> } }>(
        db,
        companyId,
        contactId,
        "GET",
        `/query?${new URLSearchParams({
          query: `SELECT * FROM Customer WHERE DisplayName = '${safeName}' MAXRESULTS 1`,
        })}`,
      );
      const found = nameRes?.QueryResponse?.Customer?.[0];
      if (found) {
        logger.info({ companyId, contactId, customerId: found.Id, match: "name" }, "QBO Customer found");
        return found.Id;
      }
    }

    const createRes = await qboRequest<{ Customer: { Id: string } }>(
      db,
      companyId,
      contactId,
      "POST",
      "/customer",
      {
        DisplayName: name,
        ...(email ? { PrimaryEmailAddr: { Address: email } } : {}),
      },
    );
    logger.info({ companyId, contactId, customerId: createRes.Customer.Id, match: "created" }, "QBO Customer created");
    return createRes.Customer.Id;
  },

  // Create an Invoice. Lines are agent-friendly { description, amount } pairs;
  // this method internally resolves the QBO Item ref required by every
  // SalesItemLineDetail (creating a "Bookkeeping Services" service Item once).
  async createInvoice(
    db: Db,
    companyId: string,
    contactId: string | null,
    customerRef: string,
    lineItems: Array<{ description: string; amount: number }>,
    dueDate: string,
  ): Promise<{ invoiceId: string; invoiceNumber: string | null; totalAmt: number; dueDate: string }> {
    const itemId = await findOrCreateBookkeepingItem(db, companyId, contactId);

    const Line = lineItems.map((l) => ({
      DetailType: "SalesItemLineDetail",
      Amount: l.amount,
      Description: l.description,
      SalesItemLineDetail: {
        ItemRef: { value: itemId, name: "Bookkeeping Services" },
      },
    }));

    const body = {
      CustomerRef: { value: customerRef },
      Line,
      DueDate: dueDate,
      EmailStatus: "NeedToSend",
    };

    const res = await qboRequest<{
      Invoice: { Id: string; DocNumber?: string; TotalAmt: number; DueDate: string };
    }>(db, companyId, contactId, "POST", "/invoice", body);

    logger.info(
      { companyId, contactId, invoiceId: res.Invoice.Id, customerRef, totalAmt: res.Invoice.TotalAmt },
      "QBO Invoice created",
    );

    return {
      invoiceId: res.Invoice.Id,
      invoiceNumber: res.Invoice.DocNumber ?? null,
      totalAmt: res.Invoice.TotalAmt,
      dueDate: res.Invoice.DueDate,
    };
  },
};

// Find or create the "Bookkeeping Services" service Item used as the line-item
// ref for every Ledgerix Pro invoice. Memoization is per-process and cheap —
// QBO query cost is one extra GET per cold start.
async function findOrCreateBookkeepingItem(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<string> {
  const existing = await qboRequest<{ QueryResponse: { Item?: Array<{ Id: string }> } }>(
    db,
    companyId,
    contactId,
    "GET",
    `/query?${new URLSearchParams({
      query: "SELECT * FROM Item WHERE Name = 'Bookkeeping Services' MAXRESULTS 1",
    })}`,
  );
  const found = existing?.QueryResponse?.Item?.[0];
  if (found) return found.Id;

  // Need an Income account ref to create a Service Item — pick the first one
  const incomeRes = await qboRequest<{
    QueryResponse: { Account?: Array<{ Id: string; Name: string }> };
  }>(
    db,
    companyId,
    contactId,
    "GET",
    `/query?${new URLSearchParams({
      query: "SELECT * FROM Account WHERE AccountType = 'Income' MAXRESULTS 1",
    })}`,
  );
  const incomeAccount = incomeRes?.QueryResponse?.Account?.[0];
  if (!incomeAccount) {
    throw new Error(
      `Cannot create 'Bookkeeping Services' Item for companyId=${companyId} contactId=${contactId}: no Income account found in QBO`,
    );
  }

  const created = await qboRequest<{ Item: { Id: string } }>(db, companyId, contactId, "POST", "/item", {
    Name: "Bookkeeping Services",
    Type: "Service",
    IncomeAccountRef: { value: incomeAccount.Id, name: incomeAccount.Name },
  });
  logger.info({ companyId, contactId, itemId: created.Item.Id }, "QBO 'Bookkeeping Services' Item created");
  return created.Item.Id;
}

// ---------------------------------------------------------------------------
// Xero
// ---------------------------------------------------------------------------

export const xero = {
  async getContacts(db: Db, companyId: string, contactId: string | null) {
    return xeroRequest(db, companyId, contactId, "GET", "/Contacts");
  },

  async getAccounts(db: Db, companyId: string, contactId: string | null) {
    return xeroRequest(db, companyId, contactId, "GET", "/Accounts");
  },

  async getProfitAndLoss(db: Db, companyId: string, contactId: string | null, fromDate: string, toDate: string) {
    const params = new URLSearchParams({ fromDate, toDate });
    return xeroRequest(db, companyId, contactId, "GET", `/Reports/ProfitAndLoss?${params}`);
  },

  async getBalanceSheet(db: Db, companyId: string, contactId: string | null, date: string) {
    const params = new URLSearchParams({ date });
    return xeroRequest(db, companyId, contactId, "GET", `/Reports/BalanceSheet?${params}`);
  },

  async getInvoices(db: Db, companyId: string, contactId: string | null) {
    const params = new URLSearchParams({ Statuses: "AUTHORISED,VOIDED" });
    return xeroRequest(db, companyId, contactId, "GET", `/Invoices?${params}`);
  },

  // Open bills (Type=ACCPAY, AUTHORISED) — overdue is computed from DueDate.
  // Xero has no OVERDUE status; AUTHORISED + DueDate < today is the equivalent.
  async getBills(db: Db, companyId: string, contactId: string | null): Promise<Bill[]> {
    const params = new URLSearchParams({ Type: "ACCPAY", Statuses: "AUTHORISED" });
    const res = await xeroRequest<{ Invoices?: XeroBill[] }>(
      db,
      companyId,
      contactId,
      "GET",
      `/Invoices?${params}`,
    );
    return (res.Invoices ?? []).map((b) => ({
      id: b.InvoiceID,
      vendorName: b.Contact?.Name ?? "",
      amount: b.Total ?? 0,
      balance: b.AmountDue ?? 0,
      dueDate: b.DueDate ?? "",
      daysDue: computeDaysDue(b.DueDate),
    }));
  },

  // Xero's /BankTransactions endpoint returns at most 100 records per page (1-indexed).
  // For backfills spanning weeks/months, a single call silently truncates. Loop with
  // ?page=N until a page returns fewer than 100 records, or until MAX_PAGES is hit.
  async getTransactions(db: Db, companyId: string, contactId: string | null, sinceDate: string): Promise<Transaction[]> {
    const XERO_PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    const baseWhere = `Date>${xeroDateTimeLiteral(sinceDate)}`;
    const all: XeroBankTransaction[] = [];
    let page = 1;
    let exhausted = false;

    while (page <= MAX_PAGES) {
      const params = new URLSearchParams({ where: baseWhere, page: String(page) });
      const res = await xeroRequest<{ BankTransactions?: XeroBankTransaction[] }>(
        db,
        companyId,
        contactId,
        "GET",
        `/BankTransactions?${params}`,
      );
      const batch = res.BankTransactions ?? [];
      all.push(...batch);
      if (batch.length < XERO_PAGE_SIZE) {
        exhausted = true;
        break;
      }
      page += 1;
    }

    if (!exhausted) {
      logger.warn(
        { companyId, contactId, totalPages: MAX_PAGES, totalRecords: all.length, maxPages: MAX_PAGES },
        "Xero BankTransactions pagination hit page cap; results may be truncated",
      );
    } else if (page > 1) {
      logger.info(
        { companyId, contactId, totalPages: page, totalRecords: all.length },
        "Xero BankTransactions pagination completed",
      );
    }

    return all.map((t) => ({
      id: t.BankTransactionID,
      type: t.Type,
      date: t.Date,
      amount: t.Total,
      vendor: t.Contact?.Name ?? null,
      accountRef: t.BankAccount?.Name ?? null,
      description: t.Reference ?? t.LineItems?.[0]?.Description ?? null,
      isReconciled: typeof t.IsReconciled === "boolean" ? t.IsReconciled : null,
      status: t.Status ?? null,
    }));
  },

  async getBankTransactions(db: Db, companyId: string, contactId: string | null, sinceDate: string): Promise<Transaction[]> {
    return xero.getTransactions(db, companyId, contactId, sinceDate);
  },

  // Read-modify-write: fetch the BankTransaction, swap the first line's AccountCode,
  // send the full record back. Xero requires the full LineItems array on update.
  async updateTransactionAccount(
    db: Db,
    companyId: string,
    contactId: string | null,
    transactionId: string,
    accountCode: string,
  ): Promise<void> {
    const current = await xeroRequest<{ BankTransactions?: XeroBankTransactionFull[] }>(
      db,
      companyId,
      contactId,
      "GET",
      `/BankTransactions/${transactionId}`,
    );
    const txn = current.BankTransactions?.[0];
    if (!txn) {
      throw new Error(`Xero BankTransaction ${transactionId} not found`);
    }
    const firstLine = txn.LineItems?.[0];
    if (!firstLine) {
      throw new Error(`Xero BankTransaction ${transactionId} has no line items to categorize`);
    }
    firstLine.AccountCode = accountCode;
    await xeroRequest(db, companyId, contactId, "POST", "/BankTransactions", { BankTransactions: [txn] });
    logger.info(
      { companyId, contactId, transactionId, accountCode },
      "Xero BankTransaction line account updated",
    );
  },

  // Apply a Payment to an Invoice. Xero requires Date — caller passes YYYY-MM-DD.
  async applyPaymentToInvoice(
    db: Db,
    companyId: string,
    contactId: string | null,
    invoiceId: string,
    amount: number,
    accountId: string,
    date: string,
  ): Promise<void> {
    const body = {
      Payments: [
        {
          Invoice: { InvoiceID: invoiceId },
          Account: { AccountID: accountId },
          Amount: amount,
          Date: date,
        },
      ],
    };
    await xeroRequest(db, companyId, contactId, "POST", "/Payments", body);
    logger.info(
      { companyId, contactId, invoiceId, amount, accountId, date },
      "Xero Payment applied to Invoice",
    );
  },
};

// ---------------------------------------------------------------------------
// Unified helper — auto-detect platform per (companyId, contactId)
// ---------------------------------------------------------------------------

export async function getNewTransactions(
  db: Db,
  companyId: string,
  contactId: string | null,
  sinceDate: string,
): Promise<{ platform: "quickbooks" | "xero"; transactions: Transaction[] }> {
  const connections = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        contactFilter(contactId),
      ),
    );

  if (connections.length === 0) {
    throw new Error(`No accounting connection found for companyId=${companyId} contactId=${contactId}`);
  }

  const platforms = new Set(connections.map((c) => c.platform));
  const hasQbo = platforms.has("quickbooks");
  const hasXero = platforms.has("xero");

  if (hasQbo && hasXero) {
    logger.warn(
      { companyId, contactId },
      "Both QBO and Xero connected — preferring QBO for getNewTransactions",
    );
  }

  if (hasQbo) {
    const transactions = await qbo.getTransactions(db, companyId, contactId, sinceDate);
    return { platform: "quickbooks", transactions };
  }

  if (hasXero) {
    const transactions = await xero.getTransactions(db, companyId, contactId, sinceDate);
    return { platform: "xero", transactions };
  }

  throw new Error(`Unsupported accounting platform for companyId=${companyId} contactId=${contactId}`);
}

// Platform-agnostic open-bills fetch. Routes to qbo.getBills or xero.getBills
// based on the platform connected for the contact. Returns all open (unpaid,
// non-zero-balance) bills, ordered by due date ascending.
export async function getBills(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<{ platform: "quickbooks" | "xero"; bills: Bill[] }> {
  const connections = await db
    .select({ platform: accountingConnections.platform })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        contactFilter(contactId),
      ),
    );

  if (connections.length === 0) {
    throw new Error(`No accounting connection found for companyId=${companyId} contactId=${contactId}`);
  }

  const platforms = new Set(connections.map((c) => c.platform));
  const hasQbo = platforms.has("quickbooks");
  const hasXero = platforms.has("xero");

  if (hasQbo && hasXero) {
    logger.warn(
      { companyId, contactId },
      "Both QBO and Xero connected — preferring QBO for getBills",
    );
  }

  if (hasQbo) {
    const bills = await qbo.getBills(db, companyId, contactId);
    return { platform: "quickbooks", bills };
  }

  if (hasXero) {
    const bills = await xero.getBills(db, companyId, contactId);
    return { platform: "xero", bills };
  }

  throw new Error(`Unsupported accounting platform for companyId=${companyId} contactId=${contactId}`);
}

// Platform-agnostic write-back. Routes to qbo.updateTransactionAccount or
// xero.updateTransactionAccount based on the platform string.
export async function updateTransactionCategory(
  db: Db,
  companyId: string,
  contactId: string | null,
  platform: "quickbooks" | "xero",
  transactionId: string,
  accountRef: string,
): Promise<void> {
  if (platform === "quickbooks") {
    return qbo.updateTransactionAccount(db, companyId, contactId, transactionId, accountRef);
  }
  if (platform === "xero") {
    return xero.updateTransactionAccount(db, companyId, contactId, transactionId, accountRef);
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

// Platform-agnostic payment-to-invoice reconciliation. For QBO, entityRef is a
// CustomerId; for Xero it is the AccountID receiving the payment. Date defaults
// to today's ISO date (YYYY-MM-DD) when omitted — required by Xero, ignored by QBO.
export async function reconcilePayment(
  db: Db,
  companyId: string,
  contactId: string | null,
  platform: "quickbooks" | "xero",
  invoiceId: string,
  amount: number,
  entityRef: string,
  date?: string,
): Promise<void> {
  const effectiveDate = date ?? new Date().toISOString().slice(0, 10);
  if (platform === "quickbooks") {
    return qbo.applyPaymentToInvoice(db, companyId, contactId, invoiceId, amount, entityRef);
  }
  if (platform === "xero") {
    return xero.applyPaymentToInvoice(db, companyId, contactId, invoiceId, amount, entityRef, effectiveDate);
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
