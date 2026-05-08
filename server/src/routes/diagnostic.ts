import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghl, ghlRequest } from "../services/ghl/index.js";
import type { GHLContact, GHLContactSearchResult } from "../services/ghl/index.js";
import { agentBridgeService } from "../services/ghl/agent-bridge.js";
import { heartbeatService } from "../services/heartbeat.js";

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";
const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";

interface DiagnosticBody {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  niche: string;
  diagnosticAmount: number;
  smsConsent?: boolean;
}

function resolveTier(amount: number): string {
  if (amount < 10_000) return "The Foundation";
  if (amount <= 50_000) return "The Growth Engine";
  return "The Scale-Up";
}

export function diagnosticRoutes(db: Db) {
  const router = Router();

  router.post("/diagnostic", async (req, res) => {
    const body = req.body as Partial<DiagnosticBody>;

    const { firstName, lastName, email, diagnosticAmount, niche, smsConsent } = body;
    if (!firstName || !lastName || !email || diagnosticAmount == null || !niche) {
      res.status(400).json({ error: "firstName, lastName, email, niche, and diagnosticAmount are required" });
      return;
    }

    const tier = resolveTier(diagnosticAmount);
    let contactId: string | null = null;

    try {
      // Search for existing contact by email
      const searchRes = await ghlRequest<GHLContactSearchResult>(
        "GET",
        `/contacts/?${new URLSearchParams({ locationId: LOCATION_ID, query: email })}`,
      );
      let contact: GHLContact | undefined = searchRes.contacts[0];

      if (!contact) {
        // Create a new contact
        const createRes = await ghlRequest<{ contact: GHLContact }>("POST", "/contacts", {
          locationId: LOCATION_ID,
          firstName,
          lastName,
          email,
          phone: body.phone,
        });
        contact = createRes.contact;
      }

      contactId = contact.id;

      // Update custom fields: diagnostic_amount and service_tier
      await ghl.contacts.updateContactFields(LOCATION_ID, contactId, {
        diagnostic_amount: diagnosticAmount,
        service_tier: tier,
      });

      // Tag the contact
      await ghl.contacts.addTag(LOCATION_ID, contactId, "diagnostic-completed");

      // Record SMS consent (A2P compliance audit trail)
      if (smsConsent === true) {
        await ghl.contacts.addTag(LOCATION_ID, contactId, "sms-consent");
        logger.info({ contactId }, `SMS consent recorded for contact ${contactId}`);
      }

      // Create Paperclip issue and queue agent wakeup
      const heartbeat = heartbeatService(db);
      const bridge = agentBridgeService(db);
      await bridge.invokeAgentForGhlEvent({
        heartbeat,
        companyId: COMPANY_ID,
        targetAgentName: "Onboarding",
        eventType: "diagnostic.submitted",
        contactId,
        locationId: LOCATION_ID,
        rawPayload: { firstName, lastName, email, niche, diagnosticAmount, tier },
      });

      logger.info({ contactId, tier, diagnosticAmount }, "Diagnostic submitted");
      res.status(200).json({ received: true, contactId, tier });
    } catch (err) {
      logger.error({ err, contactId }, "Diagnostic route error");
      res.status(200).json({ received: true, contactId, tier });
    }
  });

  return router;
}
