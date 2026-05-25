import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { serviceTierPricing, writeThresholds } from "@paperclipai/db";
import { assertInstanceAdmin, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import { compareAndSeed } from "../services/admin/compare-and-seed.js";
import { logActivity } from "../services/activity-log.js";

// Admin endpoints for safety-layer data management per Phase 4c.5
// WIP doc (docs/wip/phase-4c-5-write-endpoints-and-admin-api.md).
//
// Architectural decisions enforced here:
//   - Decision 1: Admin endpoints (not scripts) for canonical reference data.
//     Required for 7-year audit retention via activity_log.
//   - Decision 2 (revised): Use existing assertInstanceAdmin from authz.ts.
//     Supports session, board_key, and local_implicit paths — all
//     identity-tracked.
//   - Decision 3: Version-aware idempotency via compareAndSeed helper.
//     Safe re-runs (skip identical), supports change-and-re-seed (supersede),
//     preserves all versions as data.
//
// Every admin operation writes an activity_log entry with the specific user
// identity (req.actor.userId via getActorInfo) for audit retention.

const SERVICE_TIER_PRICING_SEED = [
  { tier: "Foundation", isCharter: true, monthlyAmountCents: 19900, currency: "USD" },
  { tier: "Foundation", isCharter: false, monthlyAmountCents: 29900, currency: "USD" },
  { tier: "Growth Engine", isCharter: true, monthlyAmountCents: 39900, currency: "USD" },
  { tier: "Growth Engine", isCharter: false, monthlyAmountCents: 59900, currency: "USD" },
  { tier: "Scale-Up", isCharter: true, monthlyAmountCents: 99900, currency: "USD" },
  { tier: "Scale-Up", isCharter: false, monthlyAmountCents: 129900, currency: "USD" },
];

// EA v3.3 Section 6.3 threshold defaults.
// payments: $10,000 = 1,000,000 cents
// invoices: $1,000 = 100,000 cents
const WRITE_THRESHOLDS_SEED = [
  {
    ghlContactId: null,
    endpoint: "accounting.payments",
    field: "amount",
    comparator: "gt",
    thresholdValue: 1000000,
    action: "require_approval",
    reason: "Payment amount exceeds $10,000 threshold per EA Section 6.3 — CFO must sign off",
  },
  {
    ghlContactId: null,
    endpoint: "accounting.invoices",
    field: "lineItems.sum",
    comparator: "gt",
    thresholdValue: 100000,
    action: "require_approval",
    reason: "Invoice line items total exceeds $1,000 threshold — conservative anomaly detection",
  },
];

export function adminRoutes(db: Db) {
  const router = Router();

  // POST /api/admin/pricing/seed
  // Seeds the canonical service tier pricing rows. Idempotent: re-running
  // with identical data skips; with changed data, supersedes existing
  // active rows with proper effective-dating. Activity log captures the
  // operation tied to the calling user's identity.
  router.post("/admin/pricing/seed", async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);

    try {
      const result = await compareAndSeed(db, {
        table: serviceTierPricing,
        identityFields: ["tier", "isCharter"],
        valueFields: ["monthlyAmountCents", "currency"],
        effectiveToField: "effectiveTo",
        candidateRows: SERVICE_TIER_PRICING_SEED,
        schemaLabel: "service_tier_pricing",
      });

      const audit = await logActivity(db, {
        companyId: null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "admin.pricing.seed",
        entityType: "service_tier_pricing",
        entityId: "canonical",
        agentId: null,
        status: "success",
        details: {
          inserted: result.inserted,
          skipped: result.skipped,
          superseded: result.superseded,
          newRows: result.newRows,
          candidateCount: SERVICE_TIER_PRICING_SEED.length,
        },
      });

      logger.info(
        {
          actorType: actor.actorType,
          actorId: actor.actorId,
          endpoint: "POST /api/admin/pricing/seed",
          ...result,
        },
        "admin.pricing.seed",
      );

      res.json({
        data: result,
        meta: {
          performedAt: new Date().toISOString(),
          auditLogId: audit.id,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logActivity(db, {
        companyId: null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "admin.pricing.seed",
        entityType: "service_tier_pricing",
        entityId: "canonical",
        agentId: null,
        status: "failure",
        details: { errorMessage: msg.slice(0, 500) },
      });
      throw err;
    }
  });

  // POST /api/admin/thresholds/seed
  // Seeds the canonical write threshold rows for the safety layer.
  // Same version-aware idempotency as pricing seed.
  router.post("/admin/thresholds/seed", async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);

    try {
      const result = await compareAndSeed(db, {
        table: writeThresholds,
        identityFields: ["endpoint", "field", "ghlContactId"],
        valueFields: ["comparator", "thresholdValue", "action", "reason"],
        effectiveToField: "effectiveTo",
        candidateRows: WRITE_THRESHOLDS_SEED,
        schemaLabel: "write_thresholds",
      });

      const audit = await logActivity(db, {
        companyId: null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "admin.thresholds.seed",
        entityType: "write_thresholds",
        entityId: "canonical",
        agentId: null,
        status: "success",
        details: {
          inserted: result.inserted,
          skipped: result.skipped,
          superseded: result.superseded,
          newRows: result.newRows,
          candidateCount: WRITE_THRESHOLDS_SEED.length,
        },
      });

      logger.info(
        {
          actorType: actor.actorType,
          actorId: actor.actorId,
          endpoint: "POST /api/admin/thresholds/seed",
          ...result,
        },
        "admin.thresholds.seed",
      );

      res.json({
        data: result,
        meta: {
          performedAt: new Date().toISOString(),
          auditLogId: audit.id,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logActivity(db, {
        companyId: null,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "admin.thresholds.seed",
        entityType: "write_thresholds",
        entityId: "canonical",
        agentId: null,
        status: "failure",
        details: { errorMessage: msg.slice(0, 500) },
      });
      throw err;
    }
  });

  return router;
}
