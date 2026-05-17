import { logger } from "../../middleware/logger.js";
import { assertExternalWriteAllowed } from "../external-write-guard.js";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

export class GHLApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "GHLApiError";
  }
}

export async function ghlRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env.GHL_PRIVATE_TOKEN?.trim();
  if (!token) {
    throw new GHLApiError(0, "GHL_PRIVATE_TOKEN is not set");
  }
  assertExternalWriteAllowed("GHL", method, path);

  const url = `${GHL_BASE_URL}${path}`;
  const start = Date.now();

  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_API_VERSION,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };

  const res = await fetch(url, init);
  const duration = Date.now() - start;

  logger.debug({ method, path, status: res.status, duration }, "GHL outbound request");

  if (res.ok) {
    return res.json() as Promise<T>;
  }

  let errBody: unknown;
  try {
    errBody = await res.json();
  } catch {
    errBody = await res.text().catch(() => undefined);
  }

  const message =
    errBody && typeof errBody === "object" && "message" in errBody
      ? String((errBody as Record<string, unknown>).message)
      : `GHL API error ${res.status}`;

  if (res.status === 401) {
    logger.warn({ path, status: 401 }, "GHL token invalid or expired");
    throw new GHLApiError(401, "GHL token invalid or expired", errBody);
  }

  if (res.status === 429) {
    logger.warn({ path, status: 429 }, "GHL rate limit hit");
    throw new GHLApiError(429, "GHL rate limit exceeded", errBody);
  }

  if (res.status >= 400 && res.status < 500) {
    logger.warn({ path, status: res.status, errBody }, "GHL client error");
    throw new GHLApiError(res.status, message, errBody);
  }

  logger.error({ path, status: res.status, errBody }, "GHL server error");
  throw new GHLApiError(res.status, message, errBody);
}
