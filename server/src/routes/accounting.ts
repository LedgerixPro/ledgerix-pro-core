import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";
import { getAccounts, getBills, getInvoices, getNewTransactions, getReports, qbo, reconcilePayment, PaymentReferenceError, type SupportedReportType } from "../services/accounting/index.js";
import {
  updateTransactionCategory,
  TransactionTypeNotCategorizableError,
} from "../services/accounting/transaction-write.js";
import { TransactionNotFoundError } from "../services/accounting/transaction-lookup.js";
import {
  resolveEntityRefByPlatform,
  evaluatePaymentThreshold,
  EntityRefResolutionError,
} from "../services/accounting/payments-helpers.js";
import {
  evaluateInvoicePricing,
  confidenceForMatchType,
} from "../services/accounting/invoices-helpers.js";
import {
  getExpectedPriceCents,
  getSetupFeeCents,
  PricingNotFoundError,
  SetupFeeNotFoundError,
  type ServiceTier,
} from "../services/accounting/pricing.js";
import { isCharterForInvoicing } from "../services/accounting/charter.js";
import { approvalService } from "../services/approvals.js";
import { withIdempotency } from "../services/idempotency.js";
import { requireAgentPermission } from "../middleware/require-agent-permission.js";
import {
  ACCOUNTING_APPROVAL_TYPES,
  type InvoiceDedupeAmbiguousPayload,
  type InvoicePricingMismatchPayload,
} from "../services/accounting/write-approvals.js";

const MAX_TRANSACTIONS = 5000;
const MAX_BILLS = 5000;
const MAX_INVOICES = 5000;
const MAX_ACCOUNTS = 5000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireStringParam(req: Request, name: string): string {
  const value = req.query[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing required parameter: ${name}`, {
      code: "missing_parameter",
      parameter: name,
    });
  }
  return value;
}

export function accountingRoutes(db: Db) {
  const router = Router();

  router.get("/accounting/v1/transactions", async (req, res) => {
    const startedAt = Date.now();

    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");
    const since = requireStringParam(req, "since");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    if (!ISO_DATE_RE.test(since)) {
      throw badRequest("Invalid date format for 'since'", {
        code: "invalid_parameter",
        parameter: "since",
        reason: "must be YYYY-MM-DD",
      });
    }
    const sinceDate = new Date(`${since}T00:00:00Z`);
    if (Number.isNaN(sinceDate.getTime())) {
      throw badRequest("Invalid date format for 'since'", {
        code: "invalid_parameter",
        parameter: "since",
        reason: "must be YYYY-MM-DD",
      });
    }
    const todayUtcMidnight = new Date();
    todayUtcMidnight.setUTCHours(0, 0, 0, 0);
    if (sinceDate.getTime() > todayUtcMidnight.getTime()) {
      throw badRequest("'since' cannot be in the future", {
        code: "invalid_parameter",
        parameter: "since",
      });
    }

    assertCompanyAccess(req, companyId);

    let result;
    try {
      result = await getNewTransactions(db, companyId, contactId, since);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection found")) {
        throw new HttpError(404, "No accounting connection for contact", {
          code: "no_connection",
        });
      }
      throw err;
    }

    const truncated = result.transactions.length > MAX_TRANSACTIONS;
    const data = truncated
      ? result.transactions.slice(0, MAX_TRANSACTIONS)
      : result.transactions;
    const fetchedAt = new Date().toISOString();

    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        endpoint: "GET /api/accounting/v1/transactions",
        recordsReturned: data.length,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.transactions.get",
    );

    res.json({
      data,
      meta: {
        platform: result.platform,
        fetchedAt,
        recordCount: data.length,
        truncated,
        since,
      },
    });
  });

  router.get("/accounting/v1/bills", async (req, res) => {
    const startedAt = Date.now();

    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    assertCompanyAccess(req, companyId);

    let result;
    try {
      result = await getBills(db, companyId, contactId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection found")) {
        throw new HttpError(404, "No accounting connection for contact", {
          code: "no_connection",
        });
      }
      throw err;
    }

    const truncated = result.bills.length > MAX_BILLS;
    const data = truncated ? result.bills.slice(0, MAX_BILLS) : result.bills;
    const fetchedAt = new Date().toISOString();

    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        endpoint: "GET /api/accounting/v1/bills",
        recordsReturned: data.length,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.bills.get",
    );

    res.json({
      data,
      meta: {
        platform: result.platform,
        fetchedAt,
        recordCount: data.length,
        truncated,
      },
    });
  });

  router.get("/accounting/v1/invoices", async (req, res) => {
    const startedAt = Date.now();

    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    assertCompanyAccess(req, companyId);

    let result;
    try {
      result = await getInvoices(db, companyId, contactId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection found")) {
        throw new HttpError(404, "No accounting connection for contact", {
          code: "no_connection",
        });
      }
      throw err;
    }

    const truncated = result.invoices.length > MAX_INVOICES;
    const data = truncated ? result.invoices.slice(0, MAX_INVOICES) : result.invoices;
    const fetchedAt = new Date().toISOString();

    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        endpoint: "GET /api/accounting/v1/invoices",
        recordsReturned: data.length,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.invoices.get",
    );

    res.json({
      data,
      meta: {
        platform: result.platform,
        fetchedAt,
        recordCount: data.length,
        truncated,
      },
    });
  });

  router.get("/accounting/v1/accounts", async (req, res) => {
    const startedAt = Date.now();

    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    assertCompanyAccess(req, companyId);

    let result;
    try {
      result = await getAccounts(db, companyId, contactId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection found")) {
        throw new HttpError(404, "No accounting connection for contact", {
          code: "no_connection",
        });
      }
      throw err;
    }

    const truncated = result.accounts.length > MAX_ACCOUNTS;
    const data = truncated ? result.accounts.slice(0, MAX_ACCOUNTS) : result.accounts;
    const fetchedAt = new Date().toISOString();

    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        endpoint: "GET /api/accounting/v1/accounts",
        recordsReturned: data.length,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.accounts.get",
    );

    res.json({
      data,
      meta: {
        platform: result.platform,
        fetchedAt,
        recordCount: data.length,
        truncated,
      },
    });
  });

  router.get("/accounting/v1/reports", async (req, res) => {
    const startedAt = Date.now();

    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");
    const reportType = requireStringParam(req, "type");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    // Validate report type against the supported set. Other types are defined
    // but not yet implemented in the service layer; the dispatcher will throw
    // and we'll translate that to a 501 below.
    const allowedTypes: SupportedReportType[] = [
      "ProfitAndLoss",
      "BalanceSheet",
      "CashFlow",
      "TrialBalance",
    ];
    if (!allowedTypes.includes(reportType as SupportedReportType)) {
      throw badRequest("Invalid report type", {
        code: "invalid_parameter",
        parameter: "type",
        allowed: allowedTypes,
      });
    }
    const validatedType = reportType as SupportedReportType;

    // Build date params based on report type. Period reports use startDate +
    // endDate; snapshot reports use asOfDate. We validate that the right
    // parameters are present for the requested type.
    const params: { startDate?: string; endDate?: string; asOfDate?: string } = {};
    if (validatedType === "ProfitAndLoss" || validatedType === "CashFlow") {
      const startDate = requireStringParam(req, "startDate");
      const endDate = requireStringParam(req, "endDate");
      if (!ISO_DATE_RE.test(startDate)) {
        throw badRequest("Invalid date format for 'startDate'", {
          code: "invalid_parameter",
          parameter: "startDate",
          reason: "must be YYYY-MM-DD",
        });
      }
      if (!ISO_DATE_RE.test(endDate)) {
        throw badRequest("Invalid date format for 'endDate'", {
          code: "invalid_parameter",
          parameter: "endDate",
          reason: "must be YYYY-MM-DD",
        });
      }
      params.startDate = startDate;
      params.endDate = endDate;
    } else if (validatedType === "BalanceSheet" || validatedType === "TrialBalance") {
      const asOfDate = requireStringParam(req, "asOfDate");
      if (!ISO_DATE_RE.test(asOfDate)) {
        throw badRequest("Invalid date format for 'asOfDate'", {
          code: "invalid_parameter",
          parameter: "asOfDate",
          reason: "must be YYYY-MM-DD",
        });
      }
      params.asOfDate = asOfDate;
    }

    assertCompanyAccess(req, companyId);

    let result;
    try {
      result = await getReports(db, companyId, contactId, validatedType, params);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No accounting connection found")) {
        throw new HttpError(404, "No accounting connection for contact", {
          code: "no_connection",
        });
      }
      if (msg.includes("not yet implemented")) {
        throw new HttpError(501, "Report type not yet implemented", {
          code: "not_implemented",
          reportType: validatedType,
        });
      }
      throw err;
    }

    const fetchedAt = new Date().toISOString();

    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        reportType: validatedType,
        endpoint: "GET /api/accounting/v1/reports",
        rowsReturned: result.report.rows.length,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.reports.get",
    );

    res.json({
      data: result.report,
      meta: {
        platform: result.platform,
        fetchedAt,
        rowCount: result.report.rows.length,
      },
    });
  });

  router.post("/accounting/v1/transactions/:txnId/category", requireAgentPermission(db, "accounting:write_category"), async (req, res) => {
    const startedAt = Date.now();

    // ---- URL param validation ----
    const txnId = req.params.txnId;
    if (!txnId || typeof txnId !== "string" || txnId.length > 200) {
      throw badRequest("Invalid txnId", {
        code: "invalid_parameter",
        parameter: "txnId",
      });
    }

    // ---- Body validation ----
    const body = req.body as {
      companyId?: unknown;
      contactId?: unknown;
      newAccountRef?: unknown;
      reason?: unknown;
    };
    if (!body || typeof body !== "object") {
      throw badRequest("Request body required", {
        code: "missing_body",
      });
    }
    if (typeof body.companyId !== "string" || body.companyId.length === 0) {
      throw badRequest("Invalid companyId", {
        code: "invalid_parameter",
        parameter: "companyId",
      });
    }
    if (typeof body.contactId !== "string" || body.contactId.length === 0 || body.contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }
    if (typeof body.newAccountRef !== "string" || body.newAccountRef.length === 0 || body.newAccountRef.length > 100) {
      throw badRequest("Invalid newAccountRef", {
        code: "invalid_parameter",
        parameter: "newAccountRef",
      });
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
      throw badRequest("Invalid reason", {
        code: "invalid_parameter",
        parameter: "reason",
      });
    }

    const companyId = body.companyId;
    const contactId = body.contactId;
    const newAccountRef = body.newAccountRef;
    const reason = body.reason as string | undefined;

    // ---- Auth ----
    assertCompanyAccess(req, companyId);

    // ---- Actor context for logging + approvals ----
    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    // ---- Idempotency wrapping ----
    // Per ADR-003 Q5: writes that trigger approvals MUST be idempotent.
    // We wrap the entire operation (including approval creation) in
    // withIdempotency so that a retry with the same key returns the
    // cached response (either the 200 success or the 202 pending).
    const idempotencyKey = req.header("idempotency-key") ?? null;

    const result = await withIdempotency<{
      status: "success" | "pending_approval";
      data: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>(
      db,
      {
        companyId,
        key: idempotencyKey,
        requestBody: { txnId, ...body },
      },
      async () => {
        // ---- Try the write ----
        try {
          const writeResult = await updateTransactionCategory(
            db,
            companyId,
            contactId,
            txnId,
            newAccountRef,
            // No hintedType — endpoint callers don't know transaction
            // types. The dispatcher does multi-type probe to resolve.
          );

          // SUCCESS path → 200
          return {
            status: 200,
            body: {
              status: "success" as const,
              data: {
                platform: writeResult.platform,
                txnType: writeResult.txnType,
                txnId: writeResult.txnId,
                previousAccountRef: writeResult.previousAccountRef,
                newAccountRef: writeResult.newAccountRef,
              },
              meta: {
                performedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
              },
            },
          };
        } catch (err) {
          // TRANSACTION NOT FOUND → 202 + create approval row
          if (err instanceof TransactionNotFoundError) {
            const approval = await approvalService(db).create(companyId, {
              type: ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
              status: "pending",
              // Separate FK references per actor type:
              //   - board actor → requestedByUserId (FK to users.id)
              //   - agent actor → requestedByAgentId (FK to agents.id)
              // Storing agentId in requestedByUserId would violate the users
              // FK constraint in production. The previous unified actorId
              // pattern conflated the two and was a latent FK bug surfaced
              // during Piece C review.
              requestedByUserId:
                req.actor.type === "board" ? (req.actor.userId ?? null) : null,
              requestedByAgentId:
                req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
              payload: {
                requestType: "POST /api/accounting/v1/transactions/:txnId/category",
                companyId,
                contactId,
                txnId,
                newAccountRef,
                reason: reason ?? null,
                idempotencyKey: idempotencyKey ?? null,
                unknownPreviousReason: "transaction_type_unknown",
              } as Record<string, unknown>,
            });

            return {
              status: 202,
              body: {
                status: "pending_approval" as const,
                data: {
                  approvalId: approval.id,
                  approvalType: ACCOUNTING_APPROVAL_TYPES.TRANSACTION_CATEGORY_UNKNOWN_PREVIOUS,
                  reason:
                    `Transaction ${txnId} could not be resolved against the platform's known transaction types ` +
                    `(${err.attemptedTypes.join(", ")}). The category update is queued for human review.`,
                },
                meta: {
                  performedAt: new Date().toISOString(),
                  latencyMs: Date.now() - startedAt,
                },
              },
            };
          }

          // TYPE NOT CATEGORIZABLE → 400
          if (err instanceof TransactionTypeNotCategorizableError) {
            throw badRequest(
              `Transaction type ${err.platform}.${err.txnType} does not support category updates.`,
              {
                code: "transaction_type_not_categorizable",
                platform: err.platform,
                txnType: err.txnType,
                txnId: err.txnId,
                supportedTypes: "QBO: Purchase, Bill, Deposit; Xero: BankTransaction, Invoice, Bill",
              },
            );
          }

          // Other errors propagate (HttpResponseError, network failures, etc.)
          // Caught by the global error handler — typically 502 or 500.
          throw err;
        }
      },
    );

    // ---- Logger info ----
    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        txnId,
        endpoint: "POST /api/accounting/v1/transactions/:txnId/category",
        outcomeStatus: result.body.status,
        httpStatus: result.status,
        replayed: result.replayed,
        idempotencyKeyPresent: idempotencyKey !== null,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.transactions.category.post",
    );

    // ---- Response ----
    // Add idempotencyReplay flag to meta per ADR-003 Q5
    const finalBody = {
      ...result.body,
      meta: {
        ...(result.body.meta as Record<string, unknown>),
        idempotencyReplay: result.replayed,
      },
    };
    res.status(result.status).json(finalBody);
  });

  router.post("/accounting/v1/payments", requireAgentPermission(db, "accounting:create_payment"), async (req, res) => {
    const startedAt = Date.now();

    // ---- Body validation ----
    const body = req.body as {
      companyId?: unknown;
      contactId?: unknown;
      invoiceId?: unknown;
      amount?: unknown;
      entityRef?: unknown;
      paymentDate?: unknown;
      reason?: unknown;
    };
    if (!body || typeof body !== "object") {
      throw badRequest("Request body required", {
        code: "missing_body",
      });
    }
    if (typeof body.companyId !== "string" || body.companyId.length === 0) {
      throw badRequest("Invalid companyId", {
        code: "invalid_parameter",
        parameter: "companyId",
      });
    }
    if (typeof body.contactId !== "string" || body.contactId.length === 0 || body.contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }
    if (typeof body.invoiceId !== "string" || body.invoiceId.length === 0 || body.invoiceId.length > 200) {
      throw badRequest("Invalid invoiceId", {
        code: "invalid_parameter",
        parameter: "invoiceId",
      });
    }
    if (typeof body.amount !== "number" || !Number.isInteger(body.amount) || body.amount <= 0) {
      throw badRequest("Invalid amount (must be positive integer cents)", {
        code: "invalid_parameter",
        parameter: "amount",
      });
    }
    if (typeof body.entityRef !== "string" || body.entityRef.length === 0 || body.entityRef.length > 200) {
      throw badRequest("Invalid entityRef", {
        code: "invalid_parameter",
        parameter: "entityRef",
      });
    }
    if (body.paymentDate !== undefined) {
      if (typeof body.paymentDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.paymentDate)) {
        throw badRequest("Invalid paymentDate (must be YYYY-MM-DD)", {
          code: "invalid_parameter",
          parameter: "paymentDate",
        });
      }
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
      throw badRequest("Invalid reason", {
        code: "invalid_parameter",
        parameter: "reason",
      });
    }

    const companyId = body.companyId;
    const contactId = body.contactId;
    const invoiceId = body.invoiceId;
    const amount = body.amount;
    const entityRef = body.entityRef;
    const paymentDate = body.paymentDate as string | undefined;
    const reason = body.reason as string | undefined;

    // ---- Auth ----
    assertCompanyAccess(req, companyId);

    // ---- Actor context for logging (FK-safe separation handled at approval-creation point) ----
    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    // ---- Idempotency wrapping ----
    // Per ADR-003 Q5 + Piece C pattern: writes that trigger approvals MUST be
    // idempotent. The entire flow (threshold check + reconcilePayment OR
    // approval creation) is wrapped so that a retry with the same key returns
    // the cached response (200 success or 202 pending).
    const idempotencyKey = req.header("idempotency-key") ?? null;

    const result = await withIdempotency<{
      status: "success" | "pending_approval";
      data: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>(
      db,
      {
        companyId,
        key: idempotencyKey,
        requestBody: body,
      },
      async () => {
        // ---- Step 1: Threshold check (Piece F evaluatePaymentThreshold) ----
        // Per Decision 6 Q-pay-4: threshold check happens at the route layer
        // (the only place that creates approval rows with the
        // PaymentThresholdExceededPayload). Service stays threshold-unaware.
        const thresholdResult = await evaluatePaymentThreshold(
          db,
          contactId,
          amount,
        );

        if (thresholdResult.exceeded) {
          // 202 path: threshold exceeded → create approval row, return 202.
          // FK-safe actor separation per Piece C pattern.
          const approval = await approvalService(db).create(companyId, {
            type: ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
            status: "pending",
            requestedByUserId:
              req.actor.type === "board" ? (req.actor.userId ?? null) : null,
            requestedByAgentId:
              req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
            payload: {
              requestType: "POST /api/accounting/v1/payments",
              companyId,
              contactId,
              invoiceId,
              amount,
              entityRef,
              paymentDate: paymentDate ?? null,
              reason: reason ?? null,
              idempotencyKey: idempotencyKey ?? null,
              thresholdAmount: thresholdResult.thresholdAmount!,
              // expectedRange omitted per sub-decision Q-pay-F-ii
              // (v1 ships without invoice-balance comparison)
            } as Record<string, unknown>,
          });

          return {
            status: 202,
            body: {
              status: "pending_approval" as const,
              data: {
                approvalId: approval.id,
                approvalType: ACCOUNTING_APPROVAL_TYPES.PAYMENT_THRESHOLD_EXCEEDED,
                reason:
                  thresholdResult.reason ??
                  `Payment amount ${amount} cents exceeds the applicable threshold ` +
                    `(${thresholdResult.thresholdAmount} cents). Approval required.`,
              },
              meta: {
                performedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
              },
            },
          };
        }

        // ---- Step 2: Threshold not exceeded → execute payment directly ----
        try {
          // Translate the payload's overloaded entityRef into the service's
          // split ref via the Piece F helper. Same translation logic used by
          // the approval-replay path (Piece E) — single source of truth.
          const resolved = await resolveEntityRefByPlatform(
            db,
            companyId,
            contactId,
            entityRef,
          );

          // Execute the payment via the Decision 6 dispatcher.
          const writeResult = await reconcilePayment(
            db,
            companyId,
            contactId,
            invoiceId,
            amount,
            resolved.ref,
            paymentDate,
          );

          // 200 success path.
          return {
            status: 200,
            body: {
              status: "success" as const,
              data: {
                platform: writeResult.platform,
                paymentId: writeResult.paymentId,
                invoiceId: writeResult.invoiceId,
                amount: writeResult.amount,
                customerId: writeResult.customerId,
                accountId: writeResult.accountId,
                paymentDate: writeResult.paymentDate,
              },
              meta: {
                performedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
              },
            },
          };
        } catch (err) {
          // ENTITY REF RESOLUTION FAILURE → 400 (the connection-state-dependent
          // problems are caller-correctable; surface them honestly).
          if (err instanceof EntityRefResolutionError) {
            throw badRequest(
              `Entity ref resolution failed: ${err.reason}`,
              {
                code: "entity_ref_resolution_failed",
                reason: err.reason,
                resolvedPlatform: err.resolvedPlatform,
              },
            );
          }

          // PAYMENT REFERENCE VALIDATION FAILURE → 400 (the supplied ref doesn't
          // match the resolved platform — caller-correctable).
          if (err instanceof PaymentReferenceError) {
            throw badRequest(
              `Payment reference invalid for platform ${err.platform}: ${err.reason}`,
              {
                code: "payment_reference_invalid",
                platform: err.platform,
                reason: err.reason,
              },
            );
          }

          // Other errors propagate (HttpResponseError, network failures, etc.)
          // Caught by the global error handler — typically 502 or 500.
          throw err;
        }
      },
    );

    // ---- Logger info ----
    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        invoiceId,
        amount,
        endpoint: "POST /api/accounting/v1/payments",
        outcomeStatus: result.body.status,
        httpStatus: result.status,
        replayed: result.replayed,
        idempotencyKeyPresent: idempotencyKey !== null,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.payments.post",
    );

    // ---- Response with idempotencyReplay flag ----
    const finalBody = {
      ...result.body,
      meta: {
        ...(result.body.meta as Record<string, unknown>),
        idempotencyReplay: result.replayed,
      },
    };
    res.status(result.status).json(finalBody);
  });

  // ==========================================================================
  // POST /accounting/v1/invoices — Decision 7 (DESIGN LOCKED 2026-05-28
  // Session 5; REVISED Q-inv-3-β 2026-05-28 commit 7ac02b90). Piece K.
  //
  // Gate order (locked): validate body → assertCompanyAccess → withIdempotency
  // wrap → dedupe gate (Q-inv-2) → pricing gate (Q-inv-3) → createInvoice → 201.
  //
  // Money convention (locked, see Piece K STEP 1 finding 4):
  //   - Request body lineItems[].amount: DOLLARS (matches qbo.createInvoice
  //     wire format and the already-shipped Piece I replay path).
  //   - All pricing-decision / audit fields suffixed *Cents: CENTS
  //     (sentAmountCents, expectedAmountCents, deltaCents).
  //   - Conversion is per-item rounded then summed:
  //       sentAmountCents = lineItems.reduce(
  //         (acc, li) => acc + Math.round(li.amount * 100), 0)
  //     NOT Math.round(sum * 100). Per-item rounding eliminates JS
  //     float-add accumulation error (0.1 + 0.2 ≠ 0.3) that under the
  //     locked exact-zero-tolerance comparison (Q-inv-3-α) would
  //     spuriously escalate valid multi-line invoices to HITL.
  //   - Original dollar-amount lineItems pass UNCHANGED to qbo.createInvoice.
  // ==========================================================================
  router.post("/accounting/v1/invoices", async (req, res) => {
    const startedAt = Date.now();

    // ---- Body validation ----
    const body = req.body as {
      companyId?: unknown;
      contactId?: unknown;
      customerName?: unknown;
      customerEmail?: unknown;
      serviceTier?: unknown;
      billingMode?: unknown;
      billingPeriod?: unknown;
      lineItems?: unknown;
      dueDate?: unknown;
      reason?: unknown;
    };
    if (!body || typeof body !== "object") {
      throw badRequest("Request body required", {
        code: "missing_body",
      });
    }
    if (typeof body.companyId !== "string" || body.companyId.length === 0) {
      throw badRequest("Invalid companyId", {
        code: "invalid_parameter",
        parameter: "companyId",
      });
    }
    if (typeof body.contactId !== "string" || body.contactId.length === 0 || body.contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }
    if (typeof body.customerName !== "string" || body.customerName.length === 0 || body.customerName.length > 200) {
      throw badRequest("Invalid customerName", {
        code: "invalid_parameter",
        parameter: "customerName",
      });
    }
    if (typeof body.customerEmail !== "string" || body.customerEmail.length === 0 || body.customerEmail.length > 200) {
      throw badRequest("Invalid customerEmail", {
        code: "invalid_parameter",
        parameter: "customerEmail",
      });
    }
    const ALLOWED_TIERS: ServiceTier[] = ["Foundation", "Growth Engine", "Scale-Up"];
    if (typeof body.serviceTier !== "string" || !ALLOWED_TIERS.includes(body.serviceTier as ServiceTier)) {
      throw badRequest("Invalid serviceTier (must be 'Foundation' | 'Growth Engine' | 'Scale-Up')", {
        code: "invalid_parameter",
        parameter: "serviceTier",
      });
    }
    if (body.billingMode !== "recurring" && body.billingMode !== "setup") {
      throw badRequest("Invalid billingMode (must be 'recurring' | 'setup')", {
        code: "invalid_parameter",
        parameter: "billingMode",
      });
    }
    const billingPeriod = body.billingPeriod as { start?: unknown; end?: unknown } | undefined;
    if (
      !billingPeriod ||
      typeof billingPeriod !== "object" ||
      typeof billingPeriod.start !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(billingPeriod.start) ||
      typeof billingPeriod.end !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(billingPeriod.end)
    ) {
      throw badRequest("Invalid billingPeriod (must be { start: YYYY-MM-DD, end: YYYY-MM-DD })", {
        code: "invalid_parameter",
        parameter: "billingPeriod",
      });
    }
    if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
      throw badRequest("Invalid lineItems (must be non-empty array)", {
        code: "invalid_parameter",
        parameter: "lineItems",
      });
    }
    for (let i = 0; i < body.lineItems.length; i++) {
      const li = body.lineItems[i] as { description?: unknown; amount?: unknown };
      if (
        !li ||
        typeof li !== "object" ||
        typeof li.description !== "string" ||
        li.description.length === 0 ||
        li.description.length > 500 ||
        typeof li.amount !== "number" ||
        !Number.isFinite(li.amount) ||
        li.amount <= 0
      ) {
        throw badRequest(`Invalid lineItems[${i}] (each item must be { description: non-empty string, amount: positive number in dollars })`, {
          code: "invalid_parameter",
          parameter: `lineItems[${i}]`,
        });
      }
    }
    if (body.dueDate !== undefined) {
      if (typeof body.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate)) {
        throw badRequest("Invalid dueDate (must be YYYY-MM-DD)", {
          code: "invalid_parameter",
          parameter: "dueDate",
        });
      }
      // Reject past dueDate (today UTC midnight or later is allowed).
      const todayUtcMidnight = new Date();
      todayUtcMidnight.setUTCHours(0, 0, 0, 0);
      const dueDateUtc = new Date(`${body.dueDate}T00:00:00Z`);
      if (Number.isNaN(dueDateUtc.getTime()) || dueDateUtc.getTime() < todayUtcMidnight.getTime()) {
        throw badRequest("Invalid dueDate (must not be in the past)", {
          code: "invalid_parameter",
          parameter: "dueDate",
        });
      }
    }
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500)) {
      throw badRequest("Invalid reason", {
        code: "invalid_parameter",
        parameter: "reason",
      });
    }

    const companyId = body.companyId;
    const contactId = body.contactId; // GHL contactId — used for pricing/charter lookups + payload.contactId + audit. NOT passed to QBO (Finding 3, locked).
    const customerName = body.customerName;
    const customerEmail = body.customerEmail;
    const serviceTier = body.serviceTier as ServiceTier;
    const billingMode = body.billingMode as "recurring" | "setup";
    // Validated lineItems: dollars per the locked money convention (JSDoc above).
    const lineItems = body.lineItems as Array<{ description: string; amount: number }>;
    const dueDate = body.dueDate as string | undefined;
    const reason = body.reason as string | undefined;
    const billingPeriodTyped = { start: billingPeriod.start as string, end: billingPeriod.end as string };

    // ---- Auth ----
    assertCompanyAccess(req, companyId);

    // ---- Actor context for logging (FK-safe separation handled at approval-creation point) ----
    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? null
        : req.actor.type === "board"
          ? req.actor.userId ?? null
          : null;

    // ---- Idempotency wrapping (ADR-003 Q5, Piece C/G pattern) ----
    const idempotencyKey = req.header("idempotency-key") ?? null;

    // Net-15 default per Decision 7 (no helper in codebase; inline form
    // reviewed and approved Session 5; matches Piece I replay convention).
    const resolvedDueDate =
      dueDate ??
      new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const result = await withIdempotency<{
      status: "success" | "pending_approval";
      data: Record<string, unknown>;
      meta: Record<string, unknown>;
    }>(
      db,
      {
        companyId,
        key: idempotencyKey,
        requestBody: body,
      },
      async () => {
        // ---- Step 1: Dedupe gate (Q-inv-2) ----
        // Per Finding 3 (Tenet #7 verification): findOrCreateCustomer
        // takes the QBO BOOKS key (always null for Ledgerix Pro's own-QBO
        // global connection). The GHL contactId is NOT passed.
        const resolved = await qbo.findOrCreateCustomer(
          db,
          companyId,
          null, // QBO books key
          customerName,
          customerEmail,
        );

        if (
          resolved.action === "ambiguous_name_only" ||
          resolved.action === "ambiguous_email_match_different_name"
        ) {
          const matchType =
            resolved.action === "ambiguous_name_only"
              ? "name_only"
              : "email_only_different_name";
          // Type-check the payload literal against the locked interface,
          // then cast to Record<string, unknown> for approvalService.create
          // (matches Piece G pattern — interface as compile-time contract,
          // Record on the wire).
          const dedupePayload: InvoiceDedupeAmbiguousPayload = {
            requestType: "POST /api/accounting/v1/invoices",
            companyId,
            contactId, // GHL contactId per Finding 3
            customerName,
            customerEmail,
            serviceTier,
            billingPeriod: billingPeriodTyped,
            lineItems,
            dueDate: dueDate ?? undefined,
            reason: reason ?? undefined,
            idempotencyKey: idempotencyKey ?? undefined,
            dedupeDecision: {
              matchedCustomerId: resolved.customerId,
              matchType,
              confidence: confidenceForMatchType(matchType),
            },
          };
          const approval = await approvalService(db).create(companyId, {
            type: ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
            status: "pending",
            requestedByUserId:
              req.actor.type === "board" ? (req.actor.userId ?? null) : null,
            requestedByAgentId:
              req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
            payload: dedupePayload as unknown as Record<string, unknown>,
          });

          return {
            status: 202,
            body: {
              status: "pending_approval" as const,
              data: {
                approvalId: approval.id,
                approvalType: ACCOUNTING_APPROVAL_TYPES.INVOICE_DEDUPE_AMBIGUOUS,
                reason:
                  `Customer dedupe ambiguous (${matchType}): matched existing ` +
                  `customer ${resolved.customerId}, but identity could not be ` +
                  `confirmed unambiguously. Approval required.`,
              },
              meta: {
                performedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
              },
            },
          };
        }

        // Dedupe resolved to a concrete customerId — proceed to pricing gate.
        const resolvedCustomerId = resolved.customerId;

        // ---- Step 2: Pricing gate (Q-inv-3) ----
        // Compute expected from the appropriate pricing function per Q-inv-1
        // billingMode. Recurring uses isCharter; setup does not (Q2 + Q-inv-1).
        let expectedAmountCents: number;
        let isCharter: boolean;
        try {
          if (billingMode === "recurring") {
            isCharter = await isCharterForInvoicing(db, companyId, contactId);
            const expected = await getExpectedPriceCents(
              db,
              serviceTier,
              isCharter,
              contactId,
            );
            expectedAmountCents = expected.amountCents;
          } else {
            // billingMode === "setup"
            isCharter = false; // Q-inv-1 + Q2: setup fees don't vary by charter
            const expected = await getSetupFeeCents(db, serviceTier);
            expectedAmountCents = expected.amountCents;
          }
        } catch (err) {
          // PricingNotFoundError / SetupFeeNotFoundError → 500 server-config
          // error (prod-seed-deferred state per Q2). NOT a user-correctable
          // 400 — the caller can't fix server-side seeding gaps.
          if (err instanceof PricingNotFoundError) {
            throw new HttpError(
              500,
              `Recurring pricing not configured for tier '${serviceTier}' isCharter=${isCharter!}. ` +
                `This is a server-side seeding gap; contact the operator.`,
              {
                code: "pricing_not_configured",
                serviceTier,
                isCharter: isCharter!,
              },
            );
          }
          if (err instanceof SetupFeeNotFoundError) {
            throw new HttpError(
              500,
              `Setup fee not configured for tier '${serviceTier}'. ` +
                `This is a server-side seeding gap; contact the operator.`,
              {
                code: "setup_fee_not_configured",
                serviceTier,
              },
            );
          }
          throw err;
        }

        // Per-item rounding before summing (load-bearing for the locked
        // zero-tolerance comparison — see JSDoc at top of this handler).
        const sentAmountCents = lineItems.reduce(
          (acc, li) => acc + Math.round(li.amount * 100),
          0,
        );

        const pricingEvaluation = evaluateInvoicePricing(
          sentAmountCents,
          expectedAmountCents,
        );

        if (!pricingEvaluation.matches) {
          // 202 path: pricing mismatch → create approval, return.
          const pricingPayload: InvoicePricingMismatchPayload = {
            requestType: "POST /api/accounting/v1/invoices",
            companyId,
            contactId, // GHL contactId per Finding 3
            customerName,
            customerEmail,
            serviceTier,
            billingPeriod: billingPeriodTyped,
            lineItems,
            dueDate: dueDate ?? undefined,
            reason: reason ?? undefined,
            idempotencyKey: idempotencyKey ?? undefined,
            pricingDecision: {
              sentAmountCents,
              expectedAmountCents,
              isCharter,
              deltaCents: pricingEvaluation.deltaCents,
              deltaPercent: pricingEvaluation.deltaPercent,
            },
          };
          const approval = await approvalService(db).create(companyId, {
            type: ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
            status: "pending",
            requestedByUserId:
              req.actor.type === "board" ? (req.actor.userId ?? null) : null,
            requestedByAgentId:
              req.actor.type === "agent" ? (req.actor.agentId ?? null) : null,
            payload: pricingPayload as unknown as Record<string, unknown>,
          });

          return {
            status: 202,
            body: {
              status: "pending_approval" as const,
              data: {
                approvalId: approval.id,
                approvalType: ACCOUNTING_APPROVAL_TYPES.INVOICE_PRICING_MISMATCH,
                reason:
                  `Pricing mismatch: sent ${sentAmountCents} cents, expected ` +
                  `${expectedAmountCents} cents (delta: ${pricingEvaluation.deltaCents} cents, ` +
                  `${pricingEvaluation.deltaPercent}%). Approval required.`,
              },
              meta: {
                performedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
              },
            },
          };
        }

        // ---- Step 3: Both gates passed → create invoice ----
        // Original dollar-amount lineItems pass UNCHANGED to qbo.createInvoice
        // (matches existing wire format; see top-of-handler JSDoc).
        const writeResult = await qbo.createInvoice(
          db,
          companyId,
          null, // QBO books key
          resolvedCustomerId,
          lineItems,
          resolvedDueDate,
        );

        return {
          status: 201,
          body: {
            status: "success" as const,
            data: {
              invoiceId: writeResult.invoiceId,
              invoiceNumber: writeResult.invoiceNumber,
              customerId: resolvedCustomerId,
              totalAmount: writeResult.totalAmt,
              dueDate: writeResult.dueDate,
              status: "created",
            },
            meta: {
              performedAt: new Date().toISOString(),
              latencyMs: Date.now() - startedAt,
            },
          },
        };
      },
    );

    // ---- Logger info ----
    logger.info(
      {
        actorType: req.actor.type,
        actorId,
        companyId,
        contactId,
        customerName,
        customerEmail,
        serviceTier,
        billingMode,
        endpoint: "POST /api/accounting/v1/invoices",
        outcomeStatus: result.body.status,
        httpStatus: result.status,
        replayed: result.replayed,
        idempotencyKeyPresent: idempotencyKey !== null,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.invoices.post",
    );

    // ---- Response with idempotencyReplay flag ----
    const finalBody = {
      ...result.body,
      meta: {
        ...(result.body.meta as Record<string, unknown>),
        idempotencyReplay: result.replayed,
      },
    };
    res.status(result.status).json(finalBody);
  });


  return router;
}
