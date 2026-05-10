import { Router } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { encrypt } from "../../services/accounting/encrypt.js";
import { registerQboWebhook } from "../../services/accounting/webhook-registration.js";

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const SCOPES = "com.intuit.quickbooks.accounting com.intuit.quickbooks.payment";
const STATE_TTL_MS = 10 * 60 * 1000;

interface PendingState {
  ts: number;
  contactId: string | null;
}
const pendingStates = new Map<string, PendingState>();

// Purge expired entries every 5 minutes so the Map doesn't grow unbounded
setInterval(() => {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.ts > STATE_TTL_MS) pendingStates.delete(state);
  }
}, 5 * 60 * 1000).unref();

interface QBOTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  x_refresh_token_expires_in: number;
}

export function quickbooksOAuthRoutes(db: Db) {
  const router = Router();

  router.get("/oauth/quickbooks/connect", (req, res) => {
    const contactId =
      typeof req.query.contactId === "string" && req.query.contactId.length > 0
        ? req.query.contactId
        : null;
    const state = randomUUID();
    pendingStates.set(state, { ts: Date.now(), contactId });

    const params = new URLSearchParams({
      client_id: process.env.QBO_CLIENT_ID!,
      redirect_uri: process.env.QBO_REDIRECT_URI!,
      response_type: "code",
      scope: SCOPES,
      state,
    });

    res.redirect(`${AUTH_URL}?${params}`);
  });

  router.get("/oauth/quickbooks/callback", async (req, res) => {
    const { code, state, realmId, error } = req.query as Record<string, string>;

    if (error) {
      logger.warn({ error }, "QBO OAuth error from Intuit");
      res.status(400).json({ error });
      return;
    }

    if (!code || !state || !realmId) {
      res.status(400).json({ error: "Missing code, state, or realmId" });
      return;
    }

    const stateEntry = pendingStates.get(state);
    if (!stateEntry || Date.now() - stateEntry.ts > STATE_TTL_MS) {
      res.status(400).json({ error: "Invalid or expired state" });
      return;
    }
    pendingStates.delete(state);
    const { contactId } = stateEntry;

    try {
      const basic = Buffer.from(
        `${process.env.QBO_CLIENT_ID!}:${process.env.QBO_CLIENT_SECRET!}`,
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
          redirect_uri: process.env.QBO_REDIRECT_URI!,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        logger.error({ status: tokenRes.status, body }, "QBO token exchange failed");
        res.status(500).json({ error: "Token exchange failed" });
        return;
      }

      const tokens = await tokenRes.json() as QBOTokenResponse;
      const now = new Date();
      const encryptedAccessToken = encrypt(tokens.access_token);
      const encryptedRefreshToken = encrypt(tokens.refresh_token);
      const accessTokenExpiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
      const refreshTokenExpiresAt = new Date(
        now.getTime() + tokens.x_refresh_token_expires_in * 1000,
      );

      await db
        .insert(accountingConnections)
        .values({
          companyId: COMPANY_ID,
          platform: "quickbooks",
          contactId,
          realmId,
          accessToken: encryptedAccessToken,
          refreshToken: encryptedRefreshToken,
          accessTokenExpiresAt,
          refreshTokenExpiresAt,
        })
        .onConflictDoUpdate({
          target: [
            accountingConnections.companyId,
            accountingConnections.platform,
            accountingConnections.contactId,
          ],
          set: {
            realmId,
            accessToken: encryptedAccessToken,
            refreshToken: encryptedRefreshToken,
            accessTokenExpiresAt,
            refreshTokenExpiresAt,
            updatedAt: now,
          },
        });

      logger.info({ realmId, companyId: COMPANY_ID, contactId }, "QBO OAuth connection established");

      try {
        await registerQboWebhook(db, COMPANY_ID, contactId);
      } catch (err) {
        logger.error({ err }, "QBO webhook registration failed — OAuth connection still valid");
      }

      res.redirect("/diagnostic");
    } catch (err) {
      logger.error({ err }, "QBO OAuth callback error");
      res.status(500).json({ error: "Internal error during OAuth callback" });
    }
  });

  return router;
}
