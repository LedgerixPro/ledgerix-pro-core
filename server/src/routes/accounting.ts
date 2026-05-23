import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { HttpError, badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess } from "./authz.js";
import { getBills, getInvoices, getNewTransactions } from "../services/accounting/index.js";

const MAX_TRANSACTIONS = 5000;
const MAX_BILLS = 5000;
const MAX_INVOICES = 5000;
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

  return router;
}
