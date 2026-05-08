import { logger } from "../middleware/logger.js";

const MAILGUN_BASE = "https://api.mailgun.net/v3/mail.ledgerixpro.com/messages";
const FROM = "laura@ledgerixpro.com";

export async function sendInternalEmail(
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const apiKey = process.env.MAILGUN_API_KEY;
  if (!apiKey) {
    throw new Error("MAILGUN_API_KEY is not set — cannot send internal email");
  }

  const auth = Buffer.from(`api:${apiKey}`).toString("base64");
  const payload = new URLSearchParams({ from: FROM, to, subject, text: body });

  let res: Response;
  try {
    res = await fetch(MAILGUN_BASE, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    });
  } catch (err) {
    logger.error({ to, subject, err }, "Mailgun request failed (network error)");
    throw err;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "(no body)");
    logger.error({ to, subject, status: res.status, detail }, "Mailgun rejected message");
    throw new Error(`Mailgun error ${res.status}: ${detail}`);
  }

  logger.info({ to, subject, status: res.status }, "Internal email sent via Mailgun");
}
