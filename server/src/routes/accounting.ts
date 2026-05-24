import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";
import { getAccounts, getBills, getInvoices, getNewTransactions, getReports, type SupportedReportType } from "../services/accounting/index.js";

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


  return router;
}
