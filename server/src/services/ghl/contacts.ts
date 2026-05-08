import { ghlRequest } from "./client.js";
import { FIELD_IDS } from "./types.js";
import type { FieldKey, GHLContact, GHLContactSearchResult, GHLCustomFieldWrite } from "./types.js";

interface GHLContactResponse {
  contact: GHLContact;
}

interface GHLContactUpdateBody {
  customFields?: GHLCustomFieldWrite[];
  tags?: string[];
}

export async function getContact(
  _locationId: string,
  contactId: string,
): Promise<GHLContact> {
  const res = await ghlRequest<GHLContactResponse>("GET", `/contacts/${contactId}`);
  return res.contact;
}

export async function updateContactFields(
  _locationId: string,
  contactId: string,
  fields: Partial<Record<FieldKey, string | number>>,
): Promise<GHLContact> {
  const customFields: GHLCustomFieldWrite[] = (Object.entries(fields) as [FieldKey, string | number][]).map(
    ([key, field_value]) => ({ id: FIELD_IDS[key], field_value }),
  );
  const res = await ghlRequest<GHLContactResponse>("PUT", `/contacts/${contactId}`, {
    customFields,
  } satisfies GHLContactUpdateBody);
  return res.contact;
}

export async function addTag(
  locationId: string,
  contactId: string,
  tag: string,
): Promise<GHLContact> {
  const contact = await getContact(locationId, contactId);
  const existing = contact.tags ?? [];
  if (existing.includes(tag)) return contact;
  const res = await ghlRequest<GHLContactResponse>("PUT", `/contacts/${contactId}`, {
    tags: [...existing, tag],
  } satisfies GHLContactUpdateBody);
  return res.contact;
}

export async function removeTag(
  locationId: string,
  contactId: string,
  tag: string,
): Promise<GHLContact> {
  const contact = await getContact(locationId, contactId);
  const filtered = (contact.tags ?? []).filter((t) => t !== tag);
  const res = await ghlRequest<GHLContactResponse>("PUT", `/contacts/${contactId}`, {
    tags: filtered,
  } satisfies GHLContactUpdateBody);
  return res.contact;
}

export async function searchContacts(
  locationId: string,
  query: string,
): Promise<GHLContact[]> {
  const params = new URLSearchParams({ locationId, query });
  const res = await ghlRequest<GHLContactSearchResult>("GET", `/contacts/?${params}`);
  return res.contacts;
}

export function getFieldValue(
  contact: GHLContact,
  fieldKey: FieldKey,
): string | number | undefined {
  const id = FIELD_IDS[fieldKey];
  return contact.customFields.find((f) => f.id === id)?.value;
}
