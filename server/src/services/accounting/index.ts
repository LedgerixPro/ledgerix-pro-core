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

// Open-invoice snapshot from QBO/Xero (accounts receivable side). daysDue is
// signed: positive = days until due, negative = days overdue. status reflects
// the source platform's invoice state (e.g., AUTHORISED, PAID, VOIDED for Xero
// or the QBO equivalent).
export interface Invoice {
  id: string;
  customerName: string;
  amount: number;
  balance: number;
  invoiceDate: string;
  dueDate: string;
  daysDue: number;
  status: string;
}

interface QboInvoice {
  Id: string;
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: number;
  Balance?: number;
  CustomerRef?: { value: string; name?: string };
}

interface XeroInvoice {
  InvoiceID: string;
  Type?: string;
  Status?: string;
  Contact?: { Name?: string };
  Date?: string;
  DueDate?: string;
  Total?: number;
  AmountDue?: number;
}

// Chart of Accounts entry from QBO/Xero. type is normalized to one of five
// standard accounting classes: ASSET, LIABILITY, EQUITY, REVENUE, EXPENSE.
// subType is platform-native (e.g., BANK, ACCOUNTS_RECEIVABLE, COST_OF_GOODS_SOLD)
// because agents need the platform-specific value for categorization decisions.
// Empty strings (not nulls) are used for absent optional fields to keep the
// shape predictable for agent consumers.
export interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subType: string;
  active: boolean;
  description: string;
  currencyCode: string;
}

interface QboAccount {
  Id: string;
  Name?: string;
  AcctNum?: string;
  Active?: boolean;
  Classification?: string;
  AccountType?: string;
  AccountSubType?: string;
  Description?: string;
  CurrencyRef?: { value: string; name?: string };
}

interface XeroAccount {
  AccountID: string;
  Code?: string;
  Name?: string;
  Type?: string;
  Status?: string;
  Description?: string;
  CurrencyCode?: string;
  Class?: string;
}

// Financial report row. Both QBO and Xero return reports as hierarchical
// structures; this is a flattened normalized form. type values:
//   "Header"     — section header rows (e.g., "Income", "Expenses"); amount usually 0
//   "Section"    — group/subtotal rows (sometimes called Subtotal in platforms)
//   "Row"        — data rows with an amount and a label
//   "SummaryRow" — bottom-line totals (e.g., "Net Profit", "Total Equity")
// indent encodes nesting depth (0 = top level). accountId is populated when
// a row references a specific account in the chart of accounts; null otherwise
// (e.g., subtotal/header rows that aggregate multiple accounts).
export interface ReportRow {
  label: string;
  amount: number;
  type: "Header" | "Section" | "Row" | "SummaryRow";
  indent: number;
  accountId: string | null;
}

// Normalized financial report. startDate/endDate are populated for period
// reports (P&L, Cash Flow); asOfDate is populated for snapshot reports
// (Balance Sheet, Trial Balance). The other date fields are null in each case.
export interface Report {
  reportType: string;
  reportName: string;
  startDate: string | null;
  endDate: string | null;
  asOfDate: string | null;
  rows: ReportRow[];
}

// ---------------------------------------------------------------------------
// QBO Report raw types (P&L, Balance Sheet, Cash Flow, Trial Balance share
// this general structure; per-row contents differ by report)
// ---------------------------------------------------------------------------

interface QboColData {
  value?: string;
  id?: string;
}

interface QboReportRow {
  type?: "Section" | "Data";
  group?: string;
  Header?: { ColData?: QboColData[] };
  Rows?: { Row?: QboReportRow[] };
  Summary?: { ColData?: QboColData[] };
  ColData?: QboColData[];
}

interface QboReport {
  Header?: {
    Time?: string;
    ReportName?: string;
    ReportBasis?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
    NoReportData?: boolean;
  };
  Columns?: { Column?: Array<{ ColTitle?: string; ColType?: string }> };
  Rows?: { Row?: QboReportRow[] };
}

// ---------------------------------------------------------------------------
// Xero Report raw types
// ---------------------------------------------------------------------------

interface XeroReportCell {
  Value?: string;
  Attributes?: Array<{ Id?: string; Value?: string }>;
}

interface XeroReportRow {
  RowType?: "Header" | "Section" | "Row" | "SummaryRow";
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
}

interface XeroReport {
  ReportID?: string;
  ReportName?: string;
  ReportType?: string;
  ReportTitles?: string[];
  ReportDate?: string;
  Rows?: XeroReportRow[];
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

// Parse a string like "6398.52" or "" or undefined into a number. Returns 0
// for empty/missing/unparseable values rather than NaN so downstream consumers
// don't have to defend against NaN.
function parseReportAmount(value: string | undefined): number {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Find the first attribute on a Xero report cell with Id="account" and return
// its Value (the account UUID). Returns null if not present.
function xeroAccountIdFromCell(cell: XeroReportCell | undefined): string | null {
  if (!cell?.Attributes) return null;
  const attr = cell.Attributes.find((a) => a.Id === "account");
  return attr?.Value ?? null;
}

// Flatten a Xero ReportWithRow.Rows array into our normalized ReportRow[].
// Walks the hierarchy depth-first, emitting one ReportRow per source row.
// indent reflects nesting depth: 0 for top-level rows, +1 for each Section
// we descend into.
function flattenXeroRows(rows: XeroReportRow[] | undefined, indent: number): ReportRow[] {
  if (!rows || rows.length === 0) return [];
  const out: ReportRow[] = [];
  for (const row of rows) {
    const rowType = row.RowType ?? "Row";
    if (rowType === "Section") {
      // A Section row in Xero has a Title and nested Rows. We emit a Header
      // row for the section title (if present) at the current indent, then
      // recurse into the children at indent+1. Xero already emits a separate
      // SummaryRow inside the section's Rows, so we don't synthesize one here.
      if (row.Title) {
        out.push({
          label: row.Title,
          amount: 0,
          type: "Header",
          indent,
          accountId: null,
        });
      }
      out.push(...flattenXeroRows(row.Rows, indent + 1));
    } else {
      // Header/Row/SummaryRow — emit as a leaf row using the first cell as
      // label and the second cell as amount.
      const labelCell = row.Cells?.[0];
      const amountCell = row.Cells?.[1];
      out.push({
        label: labelCell?.Value ?? "",
        amount: parseReportAmount(amountCell?.Value),
        type: rowType,
        indent,
        accountId: xeroAccountIdFromCell(labelCell),
      });
    }
  }
  return out;
}

// Get the account ID from a QBO cell's `id` field. QBO uses a single `id`
// property per cell (not an attributes array like Xero).
function qboAccountIdFromColData(cell: QboColData | undefined): string | null {
  return cell?.id ?? null;
}

// Flatten a QBO Rows.Row[] structure into our normalized ReportRow[].
// QBO Section rows are decomposed:
//   - The Header.ColData becomes a "Header" row at the current indent
//   - The nested Rows.Row[] recurse at indent+1
//   - The Summary.ColData becomes a "SummaryRow" at the current indent
// QBO Data rows become "Row" type with label from ColData[0], amount from
// the last ColData cell.
function flattenQboRows(rows: QboReportRow[] | undefined, indent: number): ReportRow[] {
  if (!rows || rows.length === 0) return [];
  const out: ReportRow[] = [];
  for (const row of rows) {
    if (row.type === "Section") {
      const headerCells = row.Header?.ColData ?? [];
      const headerLabel = headerCells[0]?.value ?? row.group ?? "";
      if (headerLabel) {
        out.push({
          label: headerLabel,
          amount: 0,
          type: "Header",
          indent,
          accountId: null,
        });
      }
      out.push(...flattenQboRows(row.Rows?.Row, indent + 1));
      const summaryCells = row.Summary?.ColData ?? [];
      if (summaryCells.length > 0) {
        const summaryLabel = summaryCells[0]?.value ?? "";
        // For multi-column reports, the amount is the last cell. For single
        // amount columns, it's still the last cell. Defensively pick the last.
        const lastCell = summaryCells[summaryCells.length - 1];
        out.push({
          label: summaryLabel,
          amount: parseReportAmount(lastCell?.value),
          type: "SummaryRow",
          indent,
          accountId: null,
        });
      }
    } else {
      // Data row (or unspecified — treat as data). First cell is label,
      // last cell is amount.
      const cells = row.ColData ?? [];
      const labelCell = cells[0];
      const lastCell = cells[cells.length - 1];
      out.push({
        label: labelCell?.value ?? "",
        amount: parseReportAmount(lastCell?.value),
        type: "Row",
        indent,
        accountId: qboAccountIdFromColData(labelCell),
      });
    }
  }
  return out;
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

  // Chart of Accounts entries from QBO. Returns all accounts (active and inactive)
  // ordered by Name. Filtering to active-only is a client responsibility because
  // bookkeeping agents sometimes need to find inactive accounts to reactivate or
  // explain historical entries. Classification is normalized to UPPERCASE for
  // consistency with the Xero side (which uses uppercase natively).
  async getAccounts(db: Db, companyId: string, contactId: string | null): Promise<Account[]> {
    const res = await qboRequest<{ QueryResponse: { Account?: QboAccount[] } }>(
      db,
      companyId,
      contactId,
      "GET",
      qboQueryUrl("SELECT * FROM Account ORDER BY Name"),
    );
    return (res.QueryResponse.Account ?? []).map((a) => ({
      id: a.Id,
      code: a.AcctNum ?? "",
      name: a.Name ?? "",
      type: (a.Classification ?? "").toUpperCase(),
      subType: a.AccountSubType ?? a.AccountType ?? "",
      active: a.Active ?? true,
      description: a.Description ?? "",
      currencyCode: a.CurrencyRef?.value ?? "",
    }));
  },

  // Profit & Loss report for a period. Returns the QBO report flattened into
  // our normalized ReportRow[] shape. The QBO API returns the report as nested
  // Section/Data rows with separate Header/Rows/Summary blocks per Section;
  // flattenQboRows handles the recursion and emits Header + Row + SummaryRow
  // outputs at appropriate indent levels.
  async getProfitAndLoss(
    db: Db,
    companyId: string,
    contactId: string | null,
    startDate: string,
    endDate: string,
  ): Promise<Report> {
    const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
    const res = await qboRequest<QboReport>(
      db,
      companyId,
      contactId,
      "GET",
      `/reports/ProfitAndLoss?${params}`,
    );
    return {
      reportType: "ProfitAndLoss",
      reportName: res.Header?.ReportName ?? "ProfitAndLoss",
      startDate: res.Header?.StartPeriod ?? startDate,
      endDate: res.Header?.EndPeriod ?? endDate,
      asOfDate: null,
      rows: flattenQboRows(res.Rows?.Row, 0),
    };
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

  // Open invoices (Invoice entity in QBO) with non-zero balance, ordered by due date.
  // QBO's QBQL does not support > or < comparisons on Balance, so we fetch all and
  // filter client-side (same constraint as getBills). Status is derived from balance
  // because QBO has no explicit AUTHORISED/PAID/VOIDED enum on Invoice.
  async getInvoices(db: Db, companyId: string, contactId: string | null): Promise<Invoice[]> {
    const res = await qboRequest<{ QueryResponse: { Invoice?: QboInvoice[] } }>(
      db,
      companyId,
      contactId,
      "GET",
      `/query?${new URLSearchParams({
        query: "SELECT * FROM Invoice ORDER BY DueDate ASC",
      })}`,
    );
    return (res.QueryResponse.Invoice ?? [])
      .filter((i) => (i.Balance ?? 0) > 0)
      .map((i) => ({
        id: i.Id,
        customerName: i.CustomerRef?.name ?? "",
        amount: i.TotalAmt ?? 0,
        balance: i.Balance ?? 0,
        invoiceDate: i.TxnDate ?? "",
        dueDate: i.DueDate ?? "",
        daysDue: computeDaysDue(i.DueDate),
        // QBO doesn't expose an explicit invoice status field for AR; balance>0
        // means it's open. Past-due distinction is encoded in daysDue (negative).
        status: "AUTHORISED",
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

  // Chart of Accounts entries from Xero. Xero's response wraps results in an
  // 'Accounts' array. Xero's 'Class' field is the high-level classification
  // (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE) while 'Type' is more specific
  // (BANK/EXPENSE/CURRENT/etc). We map Class -> our type and Type -> our subType
  // so the API surface is consistent with QBO. Status ACTIVE/ARCHIVED maps to
  // our boolean active field.
  async getAccounts(db: Db, companyId: string, contactId: string | null): Promise<Account[]> {
    const res = await xeroRequest<{ Accounts?: XeroAccount[] }>(
      db,
      companyId,
      contactId,
      "GET",
      "/Accounts",
    );
    return (res.Accounts ?? []).map((a) => ({
      id: a.AccountID,
      code: a.Code ?? "",
      name: a.Name ?? "",
      type: a.Class ?? "",
      subType: a.Type ?? "",
      active: (a.Status ?? "ACTIVE") === "ACTIVE",
      description: a.Description ?? "",
      currencyCode: a.CurrencyCode ?? "",
    }));
  },

  // Profit & Loss report for a period. Xero wraps the report in a Reports[0]
  // structure with a Rows array that contains a mix of Header / Section /
  // Row / SummaryRow types. Sections recurse into nested Rows arrays. We
  // flatten via flattenXeroRows which handles the recursion uniformly.
  async getProfitAndLoss(
    db: Db,
    companyId: string,
    contactId: string | null,
    fromDate: string,
    toDate: string,
  ): Promise<Report> {
    const params = new URLSearchParams({ fromDate, toDate });
    const res = await xeroRequest<{ Reports?: XeroReport[] }>(
      db,
      companyId,
      contactId,
      "GET",
      `/Reports/ProfitAndLoss?${params}`,
    );
    const report = res.Reports?.[0];
    return {
      reportType: report?.ReportType ?? "ProfitAndLoss",
      reportName: report?.ReportName ?? "Profit and Loss",
      startDate: fromDate,
      endDate: toDate,
      asOfDate: null,
      rows: flattenXeroRows(report?.Rows, 0),
    };
  },

  async getBalanceSheet(db: Db, companyId: string, contactId: string | null, date: string) {
    const params = new URLSearchParams({ date });
    return xeroRequest(db, companyId, contactId, "GET", `/Reports/BalanceSheet?${params}`);
  },

  // Open invoices (Type=ACCREC, AUTHORISED) with non-zero balance. ACCREC is the
  // accounts-receivable invoice type (vs ACCPAY for bills). Filter to AUTHORISED
  // status to exclude DRAFT (not sent), PAID (fully collected), and VOIDED.
  async getInvoices(db: Db, companyId: string, contactId: string | null): Promise<Invoice[]> {
    const params = new URLSearchParams({ Type: "ACCREC", Statuses: "AUTHORISED" });
    const res = await xeroRequest<{ Invoices?: XeroInvoice[] }>(
      db,
      companyId,
      contactId,
      "GET",
      `/Invoices?${params}`,
    );
    return (res.Invoices ?? [])
      .filter((i) => (i.AmountDue ?? 0) > 0)
      .map((i) => ({
        id: i.InvoiceID,
        customerName: i.Contact?.Name ?? "",
        amount: i.Total ?? 0,
        balance: i.AmountDue ?? 0,
        invoiceDate: i.Date ?? "",
        dueDate: i.DueDate ?? "",
        daysDue: computeDaysDue(i.DueDate),
        status: i.Status ?? "AUTHORISED",
      }));
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

// Platform-agnostic open-invoices fetch. Routes to qbo.getInvoices or
// xero.getInvoices based on the platform connected for the contact. Returns
// all open (non-zero-balance, AUTHORISED) invoices, ordered by due date.
export async function getInvoices(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<{ platform: "quickbooks" | "xero"; invoices: Invoice[] }> {
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
      "Both QBO and Xero connected — preferring QBO for getInvoices",
    );
  }

  if (hasQbo) {
    const invoices = await qbo.getInvoices(db, companyId, contactId);
    return { platform: "quickbooks", invoices };
  }

  if (hasXero) {
    const invoices = await xero.getInvoices(db, companyId, contactId);
    return { platform: "xero", invoices };
  }

  throw new Error(`Unsupported accounting platform for companyId=${companyId} contactId=${contactId}`);
}

export async function getAccounts(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<{ platform: "quickbooks" | "xero"; accounts: Account[] }> {
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
      "Both QBO and Xero connected — preferring QBO for getAccounts",
    );
  }

  if (hasQbo) {
    const accounts = await qbo.getAccounts(db, companyId, contactId);
    return { platform: "quickbooks", accounts };
  }

  if (hasXero) {
    const accounts = await xero.getAccounts(db, companyId, contactId);
    return { platform: "xero", accounts };
  }

  throw new Error(`Unsupported accounting platform for companyId=${companyId} contactId=${contactId}`);
}

// Supported report types as of Phase 4. ProfitAndLoss is the only one
// implemented in the v1 service layer at the moment; the other types are
// scheduled for tomorrow's session. The route validates the type before
// dispatch so unsupported values fail at 400 with a clear error.
export type SupportedReportType = "ProfitAndLoss" | "BalanceSheet" | "CashFlow" | "TrialBalance";

export interface ReportDateParams {
  // Period reports (P&L, Cash Flow) use startDate + endDate
  startDate?: string;
  endDate?: string;
  // Snapshot reports (Balance Sheet, Trial Balance) use asOfDate
  asOfDate?: string;
}

// Platform-agnostic financial-report fetch. Routes to qbo.getXxx or xero.getXxx
// based on the connected platform AND the requested report type. The caller
// supplies the dates appropriate to the report type (period vs snapshot). The
// validate-and-extract responsibility belongs to the caller (route handler).
export async function getReports(
  db: Db,
  companyId: string,
  contactId: string | null,
  reportType: SupportedReportType,
  params: ReportDateParams,
): Promise<{ platform: "quickbooks" | "xero"; report: Report }> {
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
      { companyId, contactId, reportType },
      "Both QBO and Xero connected — preferring QBO for getReports",
    );
  }

  // Dispatch to the right platform method based on report type.
  // For now only ProfitAndLoss is supported; throwing here signals the route
  // to return a 501 Not Implemented for the other types until tomorrow's work.
  if (reportType === "ProfitAndLoss") {
    if (!params.startDate || !params.endDate) {
      throw new Error("ProfitAndLoss requires startDate and endDate");
    }
    if (hasQbo) {
      const report = await qbo.getProfitAndLoss(db, companyId, contactId, params.startDate, params.endDate);
      return { platform: "quickbooks", report };
    }
    if (hasXero) {
      const report = await xero.getProfitAndLoss(db, companyId, contactId, params.startDate, params.endDate);
      return { platform: "xero", report };
    }
    throw new Error(`Unsupported accounting platform for companyId=${companyId} contactId=${contactId}`);
  }

  // Placeholder for other report types — extended tomorrow.
  throw new Error(`Report type not yet implemented: ${reportType}`);
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
