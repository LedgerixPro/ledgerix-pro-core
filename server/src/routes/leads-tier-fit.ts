import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { GHLApiError, ghl, ghlRequest } from "../services/ghl/index.js";
import type { GHLContact, GHLContactSearchResult } from "../services/ghl/index.js";

const LOCATION_ID = "GhnRONQQVJiCKsdWoQFc";

// Detect the GHL "duplicated contacts" race condition: search returned no match
// (eventual consistency) but the subsequent create failed because a parallel
// request had just created the contact. GHL returns 400 with the existing
// contactId in body.meta.contactId — recover by using it instead of failing.
function extractDuplicateContactId(err: unknown): string | null {
  if (!(err instanceof GHLApiError) || err.status !== 400) return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string" || !message.includes("duplicated contacts")) return null;
  const meta = (body as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object") return null;
  const contactId = (meta as Record<string, unknown>).contactId;
  return typeof contactId === "string" ? contactId : null;
}

// Short keys come in over the wire from the Tier-Fit Audit page; the canonical
// names match the Strategic Plan and are what gets written to GHL / read by
// downstream agents.
const TIER_KEY_TO_CANONICAL: Record<string, string> = {
  foundation: "Foundation",
  growth: "Growth Engine",
  scale: "Scale-Up",
};

interface TierFitBody {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  intent?: string;
  industry?: string;
  transactions?: string;
  accounts?: string;
  employees?: string;
  revenue?: string;
  flags?: string[];
  diagnosticAnswers?: Record<string, unknown>;
  recommendedTier?: string;
  monthlyLossEstimate?: number;
  breakdown?: unknown[];
  submittedAt?: string;
  source?: string;
}

export function leadsTierFitRoutes(db: Db) {
  const router = Router();

  router.post("/leads/tier-fit", async (req, res) => {
    const body = (req.body ?? {}) as Partial<TierFitBody>;

    // --- Validation ---
    // Required scalar fields. Missing / blank / null all fail the same way so
    // the form gets a single consistent shape per failure.
    const requiredScalars: Array<{ key: keyof TierFitBody; label: string }> = [
      { key: "firstName", label: "firstName" },
      { key: "lastName", label: "lastName" },
      { key: "email", label: "email" },
      { key: "intent", label: "intent" },
      { key: "industry", label: "industry" },
      { key: "transactions", label: "transactions" },
      { key: "accounts", label: "accounts" },
      { key: "employees", label: "employees" },
      { key: "revenue", label: "revenue" },
      { key: "recommendedTier", label: "recommendedTier" },
      { key: "submittedAt", label: "submittedAt" },
    ];
    for (const { key, label } of requiredScalars) {
      const v = body[key];
      if (v === undefined || v === null || (typeof v === "string" && v.trim().length === 0)) {
        res.status(400).json({
          error: "validation_error",
          field: label,
          message: `${label} is required`,
        });
        return;
      }
    }

    if (typeof body.monthlyLossEstimate !== "number" || Number.isNaN(body.monthlyLossEstimate)) {
      res.status(400).json({
        error: "validation_error",
        field: "monthlyLossEstimate",
        message: "monthlyLossEstimate is required and must be a number",
      });
      return;
    }

    const email = body.email!;
    if (!email.includes("@")) {
      res.status(400).json({
        error: "validation_error",
        field: "email",
        message: "email must contain '@'",
      });
      return;
    }

    if (body.intent !== "email-report-only" && body.intent !== "charter-spot-claim") {
      res.status(400).json({
        error: "validation_error",
        field: "intent",
        message: "intent must be 'email-report-only' or 'charter-spot-claim'",
      });
      return;
    }

    const canonicalTier = TIER_KEY_TO_CANONICAL[body.recommendedTier!];
    if (!canonicalTier) {
      res.status(400).json({
        error: "validation_error",
        field: "recommendedTier",
        message: "recommendedTier must be 'foundation', 'growth', or 'scale'",
      });
      return;
    }

    logger.info(
      { email, intent: body.intent, recommendedTier: body.recommendedTier, canonicalTier },
      "Tier-Fit Audit submission received",
    );

    // --- GHL contact upsert ---
    let contactId: string;
    let wasNew = false;
    try {
      const searchRes = await ghlRequest<GHLContactSearchResult>(
        "GET",
        `/contacts/?${new URLSearchParams({ locationId: LOCATION_ID, query: email })}`,
      );
      const existing = searchRes.contacts[0];
      if (existing) {
        contactId = existing.id;
        // Refresh standard fields on the existing contact. PUT will fail if blocked
        // by external-write-guard, which is the desired safety behavior in local dev.
        await ghlRequest("PUT", `/contacts/${contactId}`, {
          firstName: body.firstName,
          lastName: body.lastName,
          ...(body.phone ? { phone: body.phone } : {}),
          ...(body.company ? { companyName: body.company } : {}),
        });
      } else {
        try {
          const createRes = await ghlRequest<{ contact: GHLContact }>("POST", "/contacts", {
            locationId: LOCATION_ID,
            firstName: body.firstName,
            lastName: body.lastName,
            email,
            phone: body.phone,
            companyName: body.company,
          });
          contactId = createRes.contact.id;
          wasNew = true;
        } catch (err) {
          const recovered = extractDuplicateContactId(err);
          if (recovered) {
            contactId = recovered;
            wasNew = false;
            logger.warn(
              { contactId, email },
              "Tier-Fit Audit: duplicate-contact race detected, recovering with existing contactId",
            );
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, email }, "Tier-Fit Audit: GHL contact upsert failed");
      res.status(502).json({ error: "ghl_upsert_failed", details: msg });
      return;
    }

    logger.info({ contactId, wasNew, email }, "Tier-Fit Audit: GHL contact upserted");

    // --- Write the 10 audit_* custom fields + service_tier in one PUT ---
    try {
      await ghl.contacts.updateContactFields(LOCATION_ID, contactId, {
        audit_industry: body.industry!,
        audit_transactions: body.transactions!,
        audit_accounts: body.accounts!,
        audit_employees: body.employees!,
        audit_revenue: body.revenue!,
        audit_flags: (body.flags ?? []).join(", "),
        audit_recommended_tier: canonicalTier,
        audit_loss_estimate: body.monthlyLossEstimate!,
        audit_diagnostic_json: JSON.stringify({
          diagnosticAnswers: body.diagnosticAnswers ?? {},
          breakdown: body.breakdown ?? [],
        }),
        audit_submitted_at: body.submittedAt!,
        service_tier: canonicalTier,
      });
      logger.info({ contactId, fieldsWritten: 11 }, "Tier-Fit Audit: custom fields written");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, contactId }, "Tier-Fit Audit: custom field write failed");
      res.status(502).json({ error: "ghl_field_write_failed", details: msg });
      return;
    }

    // --- Tags ---
    const tagsAdded: string[] = [];
    try {
      await ghl.contacts.addTag(LOCATION_ID, contactId, "audit-completed");
      tagsAdded.push("audit-completed");
      const intentTag = body.intent === "charter-spot-claim" ? "audit-charter-claim" : "audit-email-only";
      await ghl.contacts.addTag(LOCATION_ID, contactId, intentTag);
      tagsAdded.push(intentTag);
      logger.info({ contactId, tagsAdded }, "Tier-Fit Audit: tags added");
    } catch (err) {
      // Tag failures don't break the lead capture — the field data is already in.
      logger.warn(
        { err, contactId, tagsAdded },
        "Tier-Fit Audit: tag write failed (non-fatal)",
      );
    }

    // Onboarding agent is woken via the GHL contact.created webhook for every
    // new contact, including audit submissions. The agent decides whether the
    // event is an audit by reading the audit_* custom fields on the contact.
    // Direct invocation was removed (2026-05-18) because it doubled wakeups
    // and added ~17s to the request — see incident logs from that date.

    logger.info(
      { contactId, canonicalTier, intent: body.intent, wasNew },
      "Tier-Fit Audit: submission complete",
    );
    res.status(200).json({ received: true, contactId, tier: canonicalTier });
  });

  return router;
}
