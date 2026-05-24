import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";
import { getAccounts, getBills, getInvoices, getNewTransactions, getReports, updateTransactionCategory, type SupportedReportType } from "../services/accounting/index.js";
import { withIdempotency, IdempotencyConflictError } from "../services/idempotency.js";
import { logActivity } from "../services/activity-log.js";

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

function requirePathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing required path parameter: ${name}`, {
      code: "missing_parameter",
      parameter: name,
    });
  }
  return value;
}

function requireBodyString(req: Request, name: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`Missing required body field: ${name}`, {
      code: "missing_field",
      field: name,
    });
  }
  return value;
}

function optionalBodyString(req: Request, name: string): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw badRequest(`Field '${name}' must be a string`, {
      code: "invalid_field",
      field: name,
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

  router.post("/accounting/v1/transactions/:txnId/category", async (req, res) => {
    const startedAt = Date.now();

    // Path + query parameters
    const txnId = requirePathParam(req, "txnId");
    const companyId = requireStringParam(req, "companyId");
    const contactId = requireStringParam(req, "contactId");

    if (contactId.length > 100) {
      throw badRequest("Invalid contactId", {
        code: "invalid_parameter",
        parameter: "contactId",
      });
    }

    // Required body
    const accountRef = requireBodyString(req, "accountRef");
    const reason = optionalBodyString(req, "reason");

    // Optional idempotency key from header
    const rawIdempotencyKey = req.headers["idempotency-key"];
    const idempotencyKey =
      typeof rawIdempotencyKey === "string" && rawIdempotencyKey.length > 0
        ? rawIdempotencyKey
        : null;
    if (idempotencyKey && idempotencyKey.length > 255) {
      throw badRequest("Idempotency-Key exceeds 255 characters", {
        code: "invalid_parameter",
        parameter: "Idempotency-Key",
      });
    }

    // Auth check (after validation per ADR-002 D5 — no audit log on validation
    // or auth failures)
    assertCompanyAccess(req, companyId);

    // Actor info for audit log
    const actorType =
      req.actor.type === "agent"
        ? "agent"
        : req.actor.type === "board"
          ? "user"
          : "system";
    const actorId =
      req.actor.type === "agent"
        ? req.actor.agentId ?? "unknown-agent"
        : req.actor.type === "board"
          ? req.actor.userId ?? "unknown-user"
          : "system";
    const agentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;

    // Wrap the upstream + audit log in idempotency
    let result: { status: number; body: Record<string, unknown> };
    let replayed: boolean;
    try {
      const idem = await withIdempotency<Record<string, unknown>>(
        db,
        {
          companyId,
          key: idempotencyKey,
          requestBody: { accountRef, reason },
        },
        async () => {
          // Upstream call FIRST per ADR-002 D2
          try {
            const update = await updateTransactionCategory(
              db,
              companyId,
              contactId,
              txnId,
              accountRef,
            );

            // Audit log success AFTER upstream success
            const audit = await logActivity(db, {
              companyId,
              actorType,
              actorId,
              action: "accounting.transactions.update_category",
              entityType: "transaction",
              entityId: txnId,
              agentId,
              status: "success",
              details: {
                platform: update.platform,
                contactId,
                newAccountRef: accountRef,
                previousAccountRef: null,
                reason,
              },
            });

            return {
              status: 200,
              body: {
                id: txnId,
                previousAccountRef: null,
                newAccountRef: accountRef,
                platform: update.platform,
                auditLogId: audit.id,
              },
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Audit log failure BEFORE returning 502
            await logActivity(db, {
              companyId,
              actorType,
              actorId,
              action: "accounting.transactions.update_category",
              entityType: "transaction",
              entityId: txnId,
              agentId,
              status: "failure",
              details: {
                contactId,
                newAccountRef: accountRef,
                reason,
                errorMessage: msg.slice(0, 500),
              },
            });

            if (msg.includes("No accounting connection found")) {
              throw new HttpError(404, "No accounting connection for contact", {
                code: "no_connection",
              });
            }
            throw new HttpError(502, "Upstream error", {
              code: "upstream_error",
            });
          }
        },
      );
      result = { status: idem.status, body: idem.body };
      replayed = idem.replayed;
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        throw new HttpError(409, "Idempotency key reused with different request body", {
          code: "idempotency_conflict",
        });
      }
      throw err;
    }

    const auditLogId = result.body.auditLogId as string | undefined;

    logger.info(
      {
        actorType: req.actor.type,
        actorId: actorId,
        companyId,
        contactId,
        txnId,
        endpoint: "POST /api/accounting/v1/transactions/:txnId/category",
        idempotencyReplay: replayed,
        latencyMs: Date.now() - startedAt,
      },
      "accounting.transactions.update_category",
    );

    res.status(result.status).json({
      data: {
        id: result.body.id,
        previousAccountRef: result.body.previousAccountRef,
        newAccountRef: result.body.newAccountRef,
        platform: result.body.platform,
      },
      meta: {
        platform: result.body.platform,
        performedAt: new Date().toISOString(),
        ...(replayed ? { idempotencyReplay: true } : {}),
        auditLogId,
      },
    });
  });

  return router;
}
