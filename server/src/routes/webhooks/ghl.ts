import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { badRequest, unauthorized } from "../../errors.js";
import { dispatcher } from "../../services/dispatcher.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { agentBridgeService } from "../../services/ghl/agent-bridge.js";

const GHL_SIGNATURE_HEADER = "x-webhook-signature";

function verifyGhlSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Strip optional "sha256=" prefix GHL may send
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function ghlWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/webhooks/ghl", async (req, res) => {
    const secret = process.env.GHL_WEBHOOK_SECRET?.trim();
    if (!secret) {
      logger.warn("GHL_WEBHOOK_SECRET is not set; rejecting webhook");
      throw unauthorized("Webhook secret not configured");
    }

    const rawBody: Buffer | undefined = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw badRequest("Empty or missing request body");
    }

    const sharedSecret = req.get("x-ledgerix-secret");
    if (sharedSecret !== undefined) {
      if (sharedSecret !== secret) {
        logger.warn({ url: req.originalUrl }, "GHL webhook shared-secret mismatch");
        throw unauthorized("Invalid shared secret");
      }
      // shared-secret matched — skip HMAC
    } else {
      const signature = req.get(GHL_SIGNATURE_HEADER);
      if (!signature) {
        throw unauthorized("Missing x-webhook-signature or x-ledgerix-secret header");
      }
      if (!verifyGhlSignature(rawBody, signature, secret)) {
        logger.warn({ url: req.originalUrl }, "GHL webhook signature verification failed");
        throw unauthorized("Signature verification failed");
      }
    }

    const body = req.body as Record<string, unknown>;
    const locationId = ((): string | undefined => {
      if (typeof body.locationId === "string") return body.locationId;
      const loc = body.location;
      if (loc && typeof loc === "object" && typeof (loc as Record<string, unknown>).id === "string") {
        return (loc as Record<string, unknown>).id as string;
      }
      return undefined;
    })();

    const customData = body.customData;
    const eventType =
      (customData !== null && typeof customData === "object" && typeof (customData as Record<string, unknown>).event === "string"
        ? (customData as Record<string, unknown>).event as string
        : undefined) ??
      (typeof body.type === "string" ? body.type : undefined) ??
      (typeof body.event === "string" ? body.event : undefined) ??
      "unknown";

    if (!locationId) {
      throw badRequest("Payload missing locationId");
    }

    const payloadSummary: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      const value = body[key];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        payloadSummary[key] = `{${Object.keys(value as object).join(", ")}}`;
      } else if (Array.isArray(value)) {
        payloadSummary[key] = `[${value.length} items]`;
      } else {
        payloadSummary[key] = value;
      }
    }

    logger.info(
      {
        timestamp: new Date().toISOString(),
        locationId,
        eventType,
        payloadSummary,
      },
      "GHL webhook received",
    );

    const routing = dispatcher.route(locationId, eventType);

    let invocation: { issued: boolean; issueId?: string; reason?: string } | null = null;
    if (routing.routed && routing.targetAgent) {
      const contactId =
        (typeof body.contact_id === "string" ? body.contact_id : undefined) ??
        (customData !== null && typeof customData === "object"
          ? (customData as Record<string, unknown>).contactId as string | undefined
          : undefined) ??
        "";

      const heartbeat = heartbeatService(db);
      const bridge = agentBridgeService(db);

      try {
        invocation = await bridge.invokeAgentForGhlEvent({
          heartbeat,
          companyId: routing.workspaceId,
          targetAgentName: routing.targetAgent,
          eventType,
          contactId,
          locationId,
          rawPayload: body,
        });
        logger.info({ invocation, eventType, locationId }, "GHL bridge invocation result");
      } catch (err) {
        logger.error({ err, eventType, locationId }, "GHL bridge invocation failed — returning 200 to prevent GHL retry");
      }
    }

    res.status(200).json({ received: true, routing, invocation });
  });

  return router;
}
