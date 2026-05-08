import { and, eq } from "drizzle-orm";
import { accountingConnections } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { encrypt, decrypt } from "./encrypt.js";
import { logger } from "../../middleware/logger.js";

const TOKEN_ENDPOINT = "https://identity.xero.com/connect/token";
const BASE_URL = "https://api.xero.com/api.xro/2.0";
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

type XeroConnection = typeof accountingConnections.$inferSelect;

async function refreshAccessToken(db: Db, connection: XeroConnection): Promise<string> {
  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID!}:${process.env.XERO_CLIENT_SECRET!}`,
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
    throw new Error(`Xero token refresh failed: ${res.status} — ${body}`);
  }

  const tokens = await res.json() as XeroTokenResponse;
  const now = new Date();

  await db
    .update(accountingConnections)
    .set({
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
      refreshTokenExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(accountingConnections.id, connection.id),
        eq(accountingConnections.platform, "xero"),
      ),
    );

  logger.info({ companyId: connection.companyId }, "Xero access token refreshed");
  return tokens.access_token;
}

export async function getXeroTenantId(db: Db, companyId: string): Promise<string> {
  const row = await db
    .select({ realmId: accountingConnections.realmId })
    .from(accountingConnections)
    .where(
      and(
        eq(accountingConnections.companyId, companyId),
        eq(accountingConnections.platform, "xero"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!row) throw new Error(`No Xero connection found for companyId=${companyId}`);
  return row.realmId;
}

export async function xeroRequest<T = unknown>(
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
        eq(accountingConnections.platform, "xero"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!connection) throw new Error(`No Xero connection found for companyId=${companyId}`);

  const url = `${BASE_URL}${path}`;

  const doRequest = (token: string) =>
    fetch(url, {
      method,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Xero-Tenant-Id": connection.realmId,
        "Accept": "application/json",
        "Content-Type": "application/json",
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

  let accessToken = decrypt(connection.accessToken);
  let response = await doRequest(accessToken);

  if (response.status === 401) {
    logger.info({ companyId, path }, "Xero 401 — refreshing token and retrying");
    accessToken = await refreshAccessToken(db, connection);
    response = await doRequest(accessToken);
  }

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Xero request failed: ${response.status} ${method} ${path} — ${errBody}`);
  }

  return response.json() as Promise<T>;
}
