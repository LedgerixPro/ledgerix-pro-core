import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { dispatcher } from "../../services/dispatcher.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { agentBridgeService } from "../../services/ghl/agent-bridge.js";

// Single-tenant: all accounting events belong to the Ledgerix Pro GHL location
const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";

// Both QBO and Xero sign with HMAC-SHA256 and base64-encode the digest
function verifyHmacBase64(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const expectedBuf = Buffer.from(expected, "base64");
  const providedBuf = Buffer.from(signature, "base64");
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

interface QboCloudEvent {
  specversion: string;
  id: string;
  source: string;
  type: string; // e.g. "qbo.payment.created.v1"
  time: string;
  intuitentityid: string;
  intuitaccountid: string; // realm ID
  data: Record<string, unknown>;
}

interface XeroEvent {
  resourceId: string;
  eventType: string;
  eventCategory: string;
  tenantId: string;
}

export function accountingWebhookRoutes(db: Db) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // QBO — POST /webhooks/accounting/quickbooks
  // ---------------------------------------------------------------------------
  router.post("/webhooks/accounting/quickbooks", async (req, res) => {
    const verifierToken = process.env.QBO_WEBHOOK_VERIFIER_TOKEN;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

    if (!rawBody || rawBody.length === 0) {
      res.status(200).json({ received: false, reason: "empty body" });
      return;
    }

    const signature = req.get("intuit-signature");
    if (!signature || !verifierToken) {
      logger.warn({ hasSignature: !!signature, hasToken: !!verifierToken }, "QBO webhook: missing signature or verifier token");
      // Return 200 to suppress QBO retries; event is not processed
      res.status(200).json({ received: false, reason: "missing auth" });
      return;
    }

    if (!verifyHmacBase64(rawBody, signature, verifierToken)) {
      logger.warn("QBO webhook: signature verification failed");
      res.status(200).json({ received: false, reason: "invalid signature" });
      return;
    }

    // Respond immediately — QBO retries on non-200 or slow response
    res.status(200).json({ received: true });

    // QBO sends a top-level CloudEvents array — warn and skip if old format received
    if (!Array.isArray(req.body)) {
      logger.warn({ bodyKeys: Object.keys(req.body as object) }, "QBO webhook: unexpected non-array body, expected CloudEvents format — skipping");
      return;
    }
    const events = req.body as QboCloudEvent[];
    const paymentEvents = events.filter((e) => typeof e.type === "string" && e.type.startsWith("qbo.payment."));

    for (const event of paymentEvents) {
      const realmId = event.intuitaccountid;
      const paymentId = event.intuitentityid;
      const operation = event.type.split(".")[2] ?? "unknown"; // "qbo.payment.created.v1" → "created"

      const conn = await db
        .select({ companyId: accountingConnections.companyId })
        .from(accountingConnections)
        .where(and(eq(accountingConnections.platform, "quickbooks"), eq(accountingConnections.realmId, realmId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!conn) {
        logger.warn({ realmId }, "QBO webhook: no connection found for realmId");
        continue;
      }

      const routing = dispatcher.route(LOCATION_ID, "invoice.paid");
      if (!routing.routed || !routing.targetAgent) continue;

      const heartbeat = heartbeatService(db);
      const bridge = agentBridgeService(db);

      try {
        const invocation = await bridge.invokeAgentForGhlEvent({
          heartbeat,
          companyId: conn.companyId,
          targetAgentName: routing.targetAgent,
          eventType: "invoice.paid",
          contactId: paymentId,
          locationId: LOCATION_ID,
          rawPayload: {
            platform: "quickbooks",
            paymentId,
            eventType: event.type,
            operation,
            realmId,
            eventId: event.id,
            eventTime: event.time,
          },
        });
        logger.info({ invocation, realmId, paymentId }, "QBO invoice.paid bridge result");
      } catch (err) {
        logger.error({ err, realmId, paymentId }, "QBO invoice.paid bridge error");
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Xero — POST /webhooks/accounting/xero
  // ---------------------------------------------------------------------------
  router.post("/webhooks/accounting/xero", async (req, res) => {
    const webhookKey = process.env.XERO_WEBHOOK_KEY;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

    if (!rawBody || rawBody.length === 0) {
      res.status(200).json({ received: true });
      return;
    }

    // Validate signature before inspecting events — Xero ITR sends bad signature and expects 401
    const signature = req.get("x-xero-signature");
    if (!signature || !webhookKey) {
      logger.warn({ hasSignature: !!signature, hasKey: !!webhookKey }, "Xero webhook: missing signature or webhook key");
      res.status(401).json({ received: false, reason: "missing auth" });
      return;
    }

    if (!verifyHmacBase64(rawBody, signature, webhookKey)) {
      logger.warn("Xero webhook: signature verification failed");
      res.status(401).json({ received: false, reason: "invalid signature" });
      return;
    }

    // Signature valid — ITR handshake sends empty events array, return 200
    const body = req.body as { events?: XeroEvent[] };
    if (!body.events || body.events.length === 0) {
      logger.info("Xero webhook: ITR handshake — valid signature, empty events, returning 200");
      res.status(200).json({ received: true });
      return;
    }

    // Respond immediately — Xero retries on slow response
    res.status(200).json({ received: true });

    const invoiceEvents = body.events.filter((e) => e.eventCategory === "INVOICE");
    if (!invoiceEvents.length) return;

    for (const event of invoiceEvents) {
      const { tenantId, resourceId } = event;

      const conn = await db
        .select({ companyId: accountingConnections.companyId })
        .from(accountingConnections)
        .where(and(eq(accountingConnections.platform, "xero"), eq(accountingConnections.realmId, tenantId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (!conn) {
        logger.warn({ tenantId }, "Xero webhook: no connection found for tenantId");
        continue;
      }

      const routing = dispatcher.route(LOCATION_ID, "invoice.paid");
      if (!routing.routed || !routing.targetAgent) continue;

      const heartbeat = heartbeatService(db);
      const bridge = agentBridgeService(db);

      try {
        const invocation = await bridge.invokeAgentForGhlEvent({
          heartbeat,
          companyId: conn.companyId,
          targetAgentName: routing.targetAgent,
          eventType: "invoice.paid",
          contactId: resourceId,
          locationId: LOCATION_ID,
          rawPayload: {
            platform: "xero",
            invoiceId: resourceId,
            tenantId,
            eventType: event.eventType,
            eventCategory: event.eventCategory,
          },
        });
        logger.info({ invocation, tenantId, invoiceId: resourceId }, "Xero invoice.paid bridge result");
      } catch (err) {
        logger.error({ err, tenantId, invoiceId: resourceId }, "Xero invoice.paid bridge error");
      }
    }
  });

  return router;
}
