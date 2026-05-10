import { eq, and, isNull } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

// QBO webhooks are registered in the Intuit developer portal at the app level.
// There is no per-connection subscription API in QBO v3.
// Register the URL manually: https://developer.intuit.com → your app → Webhooks
// URL: https://api.ledgerixpro.com/api/webhooks/accounting/quickbooks
export async function registerQboWebhook(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<void> {
  const contactFilter =
    contactId === null
      ? isNull(accountingConnections.contactId)
      : eq(accountingConnections.contactId, contactId);

  const conn = await db
    .select({ realmId: accountingConnections.realmId })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        eq(accountingConnections.platform, "quickbooks"),
        contactFilter,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!conn) {
    logger.warn({ companyId, contactId }, "registerQboWebhook: no QBO connection found");
    return;
  }

  logger.info(
    { companyId, contactId, realmId: conn.realmId },
    "QBO webhook registration is portal-level — ensure https://api.ledgerixpro.com/api/webhooks/accounting/quickbooks is registered at developer.intuit.com",
  );
}

// Xero webhooks are registered at the app level in the Xero developer portal.
// No per-tenant API call is needed — Xero routes all events to the registered URL.
// Register the URL manually: https://developer.xero.com → your app → Webhooks
// URL: https://api.ledgerixpro.com/api/webhooks/accounting/xero
export async function registerXeroWebhook(
  db: Db,
  companyId: string,
  contactId: string | null,
): Promise<void> {
  const contactFilter =
    contactId === null
      ? isNull(accountingConnections.contactId)
      : eq(accountingConnections.contactId, contactId);

  const conn = await db
    .select({ realmId: accountingConnections.realmId })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        eq(accountingConnections.platform, "xero"),
        contactFilter,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!conn) {
    logger.warn({ companyId, contactId }, "registerXeroWebhook: no Xero connection found");
    return;
  }

  logger.info(
    { companyId, contactId, tenantId: conn.realmId },
    "Xero webhook registration is portal-level — ensure https://api.ledgerixpro.com/api/webhooks/accounting/xero is registered at developer.xero.com",
  );
}
