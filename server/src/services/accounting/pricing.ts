import { and, eq, isNull } from "drizzle-orm";
import { clientPricingOverrides, serviceTierPricing, setupFeePricing } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

// Pricing source-of-truth for Ledgerix Pro service tiers per ADR-003 Q6.
//
// Lookup precedence:
//   1. Active client override for (contactId, tier) — if present, use this
//   2. Active canonical price for (tier, isCharter) — fallback
//
// "Active" means effective_to IS NULL. Historical pricing is preserved as
// rows with effective_to set, but those are not used for lookups.
//
// Returns the amount in cents plus a `source` discriminator so callers can
// audit which path was taken. priceRecordId is the UUID of the row that
// supplied the value, useful for the audit log entry on invoice creation.

export type ServiceTier = "Foundation" | "Growth Engine" | "Scale-Up";

export type PricingSource = "override" | "tier_charter" | "tier_standard";

export interface ExpectedPrice {
  amountCents: number;
  source: PricingSource;
  priceRecordId: string;
}

export class PricingNotFoundError extends Error {
  constructor(tier: string, isCharter: boolean) {
    super(`No active price found for tier='${tier}' isCharter=${isCharter}`);
    this.name = "PricingNotFoundError";
  }
}

// Get the expected monthly price for a given tier + charter combination,
// honoring per-client overrides if a contactId is provided and an override
// exists for that (contactId, tier) pair.
//
// Throws PricingNotFoundError if no canonical price exists for the tier+
// charter combination (indicates a configuration gap — canonical pricing
// should be seeded before this function is called).
export async function getExpectedPriceCents(
  db: Db,
  tier: ServiceTier,
  isCharter: boolean,
  contactId?: string | null,
): Promise<ExpectedPrice> {
  // Step 1: check for an active per-client override
  if (contactId) {
    const overrides = await db
      .select()
      .from(clientPricingOverrides)
      .where(
        and(
          eq(clientPricingOverrides.ghlContactId, contactId),
          eq(clientPricingOverrides.tier, tier),
          isNull(clientPricingOverrides.effectiveTo),
        ),
      )
      .limit(1);

    if (overrides.length > 0) {
      return {
        amountCents: overrides[0].monthlyAmountCents,
        source: "override",
        priceRecordId: overrides[0].id,
      };
    }
  }

  // Step 2: fall back to canonical tier pricing
  const tierPrices = await db
    .select()
    .from(serviceTierPricing)
    .where(
      and(
        eq(serviceTierPricing.tier, tier),
        eq(serviceTierPricing.isCharter, isCharter),
        isNull(serviceTierPricing.effectiveTo),
      ),
    )
    .limit(1);

  if (tierPrices.length === 0) {
    throw new PricingNotFoundError(tier, isCharter);
  }

  return {
    amountCents: tierPrices[0].monthlyAmountCents,
    source: isCharter ? "tier_charter" : "tier_standard",
    priceRecordId: tierPrices[0].id,
  };
}

// ============================================================================
// Setup fees (Q2)
// ============================================================================
//
// Setup fees are structurally different from monthly recurring pricing:
//   - They don't vary by Charter status (EA Section 7: "All clients
//     (including Charter) pay a one-time setup fee at onboarding")
//   - They don't have per-client overrides (v1 scope; may extend later)
//
// The function signature reflects this — only `tier` is required, no
// isCharter or contactId. See setup_fee_pricing.ts for the schema rationale.

export interface SetupFee {
  amountCents: number;
  priceRecordId: string;
}

export class SetupFeeNotFoundError extends Error {
  constructor(tier: string) {
    super(`No active setup fee found for tier='${tier}'`);
    this.name = "SetupFeeNotFoundError";
  }
}

// Get the one-time setup fee for a service tier. Returns the currently
// active fee (effective_to IS NULL). Throws SetupFeeNotFoundError if no
// active row exists for the tier — indicates a configuration gap, the
// admin seed endpoint should have populated this row.
export async function getSetupFeeCents(
  db: Db,
  tier: ServiceTier,
): Promise<SetupFee> {
  const rows = await db
    .select({
      id: setupFeePricing.id,
      amountCents: setupFeePricing.amountCents,
    })
    .from(setupFeePricing)
    .where(
      and(eq(setupFeePricing.tier, tier), isNull(setupFeePricing.effectiveTo)),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new SetupFeeNotFoundError(tier);
  }

  return {
    amountCents: rows[0].amountCents,
    priceRecordId: rows[0].id,
  };
}
