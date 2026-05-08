import { logger } from "../../middleware/logger.js";
import { GHLApiError, ghlRequest } from "./client.js";
import type { GHLSendMessageResult } from "./types.js";

// Thrown when GHL rejects a message because the contact has no phone/email.
// The SDR agent should catch this and escalate rather than retry.
export class GHLMissingChannelError extends GHLApiError {
  readonly channel: "SMS" | "Email";
  constructor(channel: "SMS" | "Email", contactId: string) {
    super(
      400,
      `Contact ${contactId} has no ${channel === "SMS" ? "phone number" : "email address"} — cannot send ${channel}`,
    );
    this.name = "GHLMissingChannelError";
    this.channel = channel;
  }
}

export async function sendSms(
  _locationId: string,
  contactId: string,
  message: string,
): Promise<string> {
  let res: GHLSendMessageResult;
  try {
    res = await ghlRequest<GHLSendMessageResult>("POST", "/conversations/messages", {
      type: "SMS",
      contactId,
      message,
    });
  } catch (err) {
    if (err instanceof GHLApiError && (err.status === 400 || err.status === 422)) {
      throw new GHLMissingChannelError("SMS", contactId);
    }
    throw err;
  }
  logger.info({ contactId, channel: "SMS", messageLength: message.length }, "GHL message sent");
  return res.messageId;
}

export async function sendEmail(
  _locationId: string,
  contactId: string,
  subject: string,
  body: string,
): Promise<string> {
  let res: GHLSendMessageResult;
  try {
    res = await ghlRequest<GHLSendMessageResult>("POST", "/conversations/messages", {
      type: "Email",
      contactId,
      subject,
      html: body,
    });
  } catch (err) {
    if (err instanceof GHLApiError && (err.status === 400 || err.status === 422)) {
      throw new GHLMissingChannelError("Email", contactId);
    }
    throw err;
  }
  logger.info({ contactId, channel: "Email", messageLength: body.length }, "GHL message sent");
  return res.messageId;
}
