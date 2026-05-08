import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { encrypt } from "../../services/accounting/encrypt.js";
import { registerXeroWebhook } from "../../services/accounting/webhook-registration.js";

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const TOKEN_ENDPOINT = "https://identity.xero.com/connect/token";
const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
  "accounting.manualjournals.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.balancesheet.read",
  "accounting.settings.read",
].join(" ");
const STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

const pendingStates = new Map<string, number>(); // state UUID -> timestamp

// Purge expired entries every 5 minutes so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [state, ts] of pendingStates) {
    if (now - ts > STATE_TTL_MS) pendingStates.delete(state);
  }
}, 5 * 60 * 1000).unref();

interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface XeroTenant {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

export function xeroOAuthRoutes(db: Db) {
  const router = Router();

  router.get("/oauth/xero/connect", (_req, res) => {
    const state = randomUUID();
    pendingStates.set(state, Date.now());

    const params = new URLSearchParams({
      client_id: process.env.XERO_CLIENT_ID!,
      redirect_uri: process.env.XERO_REDIRECT_URI!,
      response_type: "code",
      scope: SCOPES,
      state,
    });

    res.redirect(`${AUTH_URL}?${params}`);
  });

  router.get("/oauth/xero/callback", async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      logger.warn({ error }, "Xero OAuth error from Xero");
      res.status(400).json({ error });
      return;
    }

    if (!code || !state) {
      res.status(400).json({ error: "Missing code or state" });
      return;
    }

    const stateTs = pendingStates.get(state);
    if (!stateTs || Date.now() - stateTs > STATE_TTL_MS) {
      res.status(400).json({ error: "Invalid or expired state" });
      return;
    }
    pendingStates.delete(state);

    try {
      const basic = Buffer.from(
        `${process.env.XERO_CLIENT_ID!}:${process.env.XERO_CLIENT_SECRET!}`,
      ).toString("base64");

      const tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: process.env.XERO_REDIRECT_URI!,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        logger.error({ status: tokenRes.status, body }, "Xero token exchange failed");
        res.status(500).json({ error: "Token exchange failed" });
        return;
      }

      const tokens = await tokenRes.json() as XeroTokenResponse;

      // Fetch connected tenants and use the first one's tenantId as realm_id
      const connectionsRes = await fetch("https://api.xero.com/connections", {
        headers: {
          "Authorization": `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
        },
      });

      if (!connectionsRes.ok) {
        const body = await connectionsRes.text();
        logger.error({ status: connectionsRes.status, body }, "Xero connections fetch failed");
        res.status(500).json({ error: "Failed to fetch Xero tenants" });
        return;
      }

      const tenants = await connectionsRes.json() as XeroTenant[];
      if (!tenants.length) {
        res.status(400).json({ error: "No Xero tenants connected" });
        return;
      }

      const tenantId = tenants[0].tenantId;
      const now = new Date();
      const encryptedAccessToken = encrypt(tokens.access_token);
      const encryptedRefreshToken = encrypt(tokens.refresh_token);
      const accessTokenExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
      const refreshTokenExpiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

      await db
        .insert(accountingConnections)
        .values({
          companyId: COMPANY_ID,
          platform: "xero",
          realmId: tenantId,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
        })
        .onConflictDoUpdate({
          target: [accountingConnections.companyId, accountingConnections.platform],
          set: {
            realmId: tenantId,
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
            updatedAt: now,
          },
        });

      logger.info({ tenantId, companyId: COMPANY_ID }, "Xero OAuth connection established");

      try {
        await registerXeroWebhook(db, COMPANY_ID);
      } catch (err) {
        logger.error({ err }, "Xero webhook registration failed — OAuth connection still valid");
      }

      res.redirect("/diagnostic");
    } catch (err) {
      logger.error({ err }, "Xero OAuth callback error");
      res.status(500).json({ error: "Internal error during OAuth callback" });
    }
  });

  return router;
}
