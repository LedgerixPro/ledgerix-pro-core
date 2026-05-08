import { and, eq } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { encrypt, decrypt } from "./encrypt.js";
import { logger } from "../../middleware/logger.js";

const TOKEN_ENDPOINT = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function getBaseUrl(realmId: string): string {
  const host =
    process.env.QBO_ENVIRONMENT === "production"
      ? "quickbooks.api.intuit.com"
      : "sandbox-quickbooks.api.intuit.com";
  return `https://${host}/v3/company/${realmId}`;
}

interface QBOTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
}

type QboConnection = typeof accountingConnections.$inferSelect;

async function refreshAccessToken(db: Db, connection: QboConnection): Promise<string> {
  const basic = Buffer.from(
    `${process.env.QBO_CLIENT_ID!}:${process.env.QBO_CLIENT_SECRET!}`,
  ).toString("base64");

  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: decrypt(connection.refreshToken),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`QBO token refresh failed: ${res.status} — ${body}`);
  }

  const tokens = await res.json() as QBOTokenResponse;
  const now = new Date();

  await db
    .update(accountingConnections)
    .set({
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now.getTime() + tokens.x_refresh_token_expires_in * 1000),
      updatedAt: now,
    })
    .where(eq(accountingConnections.id, connection.id));

  logger.info({ companyId: connection.companyId }, "QBO access token refreshed");
  return tokens.access_token;
}

export async function getQboRealmId(db: Db, companyId: string): Promise<string> {
  const row = await db
    .select({ realmId: accountingConnections.realmId })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        eq(accountingConnections.platform, "quickbooks"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) throw new Error(`No QBO connection found for companyId=${companyId}`);
  return row.realmId;
}

export async function qboRequest<T = unknown>(
  db: Db,
  companyId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const connection = await db
    .select()
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        eq(accountingConnections.platform, "quickbooks"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!connection) throw new Error(`No QBO connection found for companyId=${companyId}`);

  const url = `${getBaseUrl(connection.realmId)}${path}`;

  const doRequest = (token: string) =>
    fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

  let accessToken = decrypt(connection.accessToken);
  let response = await doRequest(accessToken);

  if (response.status === 401) {
    logger.info({ companyId, path }, "QBO 401 — refreshing token and retrying");
    accessToken = await refreshAccessToken(db, connection);
    response = await doRequest(accessToken);
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`QBO request failed: ${response.status} ${method} ${path} — ${errBody}`);
  }

  return response.json() as Promise<T>;
}
