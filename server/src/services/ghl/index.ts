// Usage:
//   import { ghl, getFieldValue } from '../services/ghl/index.js';
//   await ghl.contacts.updateContactFields(locationId, contactId, { icp_status: 'Qualified' });
//   await ghl.conversations.sendSms(locationId, contactId, message);
//   await ghl.opportunities.create(locationId, { contactId, name });
//   const score = getFieldValue(contact, 'signal_confidence_score');

export * from "./types.js";
export { GHLApiError, ghlRequest } from "./client.js";
export { GHLMissingChannelError } from "./conversations.js";
export * as contacts from "./contacts.js";
export * as conversations from "./conversations.js";
export * as opportunities from "./opportunities.js";
export { getFieldValue } from "./contacts.js";

import * as contacts from "./contacts.js";
import * as conversations from "./conversations.js";
import { createOpportunity, getPipelines } from "./opportunities.js";

export const ghl = {
  contacts,
  conversations,
  opportunities: {
    create: createOpportunity,
    getPipelines,
  },
};
