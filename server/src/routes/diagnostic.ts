import { Router } from "express";
import { eq } from "drizzle-orm";
import { smsConsentLog } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { ghl, ghlRequest } from "../services/ghl/index.js";
import type { GHLContact, GHLContactSearchResult } from "../services/ghl/index.js";
import { agentBridgeService } from "../services/ghl/agent-bridge.js";
import { heartbeatService } from "../services/heartbeat.js";

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";
const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";

// Exact disclosure text shown on the diagnostic form's SMS-consent checkbox
// and at /sms-consent.html. Must match both verbatim — the row stored in
// sms_consent_log preserves a historical snapshot for A2P 10DLC audits even
// if the disclosure copy is later revised.
const CONSENT_TEXT_VERSION = "v2026-05-11";
const CONSENT_TEXT = "I agree to receive marketing and informational SMS messages from Ledgerix Pro LLC regarding bookkeeping services and my account. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out at any time. View our Privacy Policy and Terms of Service.";

interface DiagnosticBody {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  companyName?: string;
  niche: string;
  diagnosticAmount: number;
  smsConsent?: boolean;
  inputs?: Record<string, unknown>;
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

    // A2P 10DLC / TCPA: consent is required to collect a phone number on this
    // form. The frontend enforces this too — this is defense-in-depth.
    if (body.phone && body.phone.trim().length > 0 && smsConsent !== true) {
      res.status(400).json({
        error: "sms_consent_required",
        message: "SMS consent is required when a phone number is provided. Submit without a phone number, or check the SMS consent box.",
      });
      return;
    }

    if (!firstName || !lastName || !email || diagnosticAmount == null || !niche) {
      res.status(400).json({ error: "firstName, lastName, email, niche, and diagnosticAmount are required" });
      return;
    }

    const tier = resolveTier(diagnosticAmount);
    let contactId: string | null = null;
    let consentRowId: string | null = null;

    // Capture audit metadata before the consent insert.
    // CF tunnel sets cf-connecting-ip; x-forwarded-for is the fallback;
    // req.ip is the proxy IP unless `trust proxy` is enabled app-level
    // (it is not). Behind Cloudflare / Railway edge the headers above
    // are the real client IP.
    const clientIp =
      (req.headers["cf-connecting-ip"] as string | undefined) ??
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.ip ??
      null;
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;
    const sourceUrl = (req.headers["referer"] as string | undefined) ?? "https://api.ledgerixpro.com/diagnostic";

    // Insert the consent audit row BEFORE the GHL upsert so the record
    // exists even if GHL is unavailable. Only insert when a phone was
    // provided — phone is NOT NULL on the table, and consent without a
    // phone has no meaning.
    if (body.phone && body.phone.trim().length > 0) {
      try {
        const inserted = await db
          .insert(smsConsentLog)
          .values({
            contactId: null, // backfilled after GHL upsert succeeds
            email: body.email ?? null,
            phone: body.phone,
            consentGranted: smsConsent === true,
            consentText: CONSENT_TEXT,
            consentTextVersion: CONSENT_TEXT_VERSION,
            sourceUrl,
            ipAddress: clientIp,
            userAgent,
          })
          .returning({ id: smsConsentLog.id });
        consentRowId = inserted[0]?.id ?? null;
        logger.info(
          { consentRowId, phone: body.phone, consentGranted: smsConsent === true },
          "SMS consent row inserted",
        );
      } catch (err) {
        // Audit log insert is critical for compliance. If it fails, do
        // not proceed — we can't legally text someone we have no record
        // of consenting.
        logger.error({ err }, "Failed to insert sms_consent_log row");
        res.status(500).json({
          error: "consent_log_failed",
          message: "Could not record consent. Please try again.",
        });
        return;
      }
    }

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
          companyName: body.companyName,
        });
        contact = createRes.contact;
      }

      contactId = contact.id;

      // Backfill the consent row with the resolved GHL contactId.
      // Non-fatal: the row exists either way; this only adds the GHL link.
      if (consentRowId) {
        try {
          await db
            .update(smsConsentLog)
            .set({ contactId })
            .where(eq(smsConsentLog.id, consentRowId));
        } catch (err) {
          logger.warn(
            { err, consentRowId, contactId },
            "Failed to backfill contactId on sms_consent_log row (non-fatal)",
          );
        }
      }

      // Update custom fields: diagnostic_amount and service_tier
      await ghl.contacts.updateContactFields(LOCATION_ID, contactId, {
        diagnostic_amount: diagnosticAmount,
        service_tier: tier,
      });

      // Tag the contact
      await ghl.contacts.addTag(LOCATION_ID, contactId, "diagnostic-completed");

      // Record SMS consent (A2P compliance audit trail). The sms_consent_log
      // row above is the authoritative record; this tag is redundant but
      // agents read it during outreach.
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
        rawPayload: {
          firstName,
          lastName,
          email,
          niche,
          diagnosticAmount,
          tier,
          companyName: body.companyName,
          inputs: body.inputs,
        },
      });

      logger.info(
        { contactId, tier, diagnosticAmount, companyName: body.companyName, hasInputs: body.inputs != null },
        "Diagnostic submitted",
      );
      res.status(200).json({ received: true, contactId, tier });
    } catch (err) {
      logger.error({ err, contactId }, "Diagnostic route error");
      res.status(200).json({ received: true, contactId, tier });
    }
  });

  return router;
}
