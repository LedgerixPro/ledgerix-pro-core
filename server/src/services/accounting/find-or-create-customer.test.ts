import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock qbo-client BEFORE importing the qbo object
vi.mock("./qbo-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qbo-client.js")>();
  return {
    ...actual,
    qboRequest: vi.fn(),
  };
});

import { qbo } from "./index.js";
import { qboRequest } from "./qbo-client.js";

const COMPANY_ID = "f60117de-1131-433c-934f-3fe88bfaa163";
const CONTACT_ID = "test-contact-id";
const MOCK_DB = {} as never; // findOrCreateCustomer doesn't use db directly for QBO

// Helper builders for QBO query responses
function emailQueryResponse(opts: {
  id?: string;
  displayName?: string;
  email?: string | null;
} | null) {
  if (!opts) return { QueryResponse: {} };
  return {
    QueryResponse: {
      Customer: [
        {
          Id: opts.id ?? "cust-1",
          DisplayName: opts.displayName ?? "Test Customer",
          ...(opts.email !== null && opts.email !== undefined
            ? { PrimaryEmailAddr: { Address: opts.email } }
            : {}),
        },
      ],
    },
  };
}

function nameQueryResponse(opts: {
  id?: string;
  displayName?: string;
  email?: string | null;
} | null) {
  // Same shape as email query response (both query the Customer table)
  return emailQueryResponse(opts);
}

function emptyQueryResponse() {
  return { QueryResponse: {} };
}

function createResponse(id: string) {
  return { Customer: { Id: id } };
}

describe("findOrCreateCustomer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns found_by_email when email matches and names are similar", async () => {
    vi.mocked(qboRequest).mockResolvedValueOnce(
      emailQueryResponse({ id: "cust-100", displayName: "Acme Inc", email: "billing@acme.com" }),
    );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "billing@acme.com",
    );

    expect(result.action).toBe("found_by_email");
    expect(result.customerId).toBe("cust-100");
    expect(result.matchDetails).toBeUndefined();
  });

  it("returns found_by_email when email matches and stored name is empty", async () => {
    vi.mocked(qboRequest).mockResolvedValueOnce(
      emailQueryResponse({ id: "cust-101", displayName: "", email: "billing@acme.com" }),
    );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "billing@acme.com",
    );

    expect(result.action).toBe("found_by_email");
    expect(result.customerId).toBe("cust-101");
  });

  it("returns ambiguous_email_match_different_name when email matches but names differ", async () => {
    vi.mocked(qboRequest).mockResolvedValueOnce(
      emailQueryResponse({
        id: "cust-102",
        displayName: "Globex Corporation",
        email: "billing@acme.com",
      }),
    );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "billing@acme.com",
    );

    expect(result.action).toBe("ambiguous_email_match_different_name");
    expect(result.customerId).toBe("cust-102");
    expect(result.matchDetails).toEqual({
      submittedName: "Acme Inc",
      submittedEmail: "billing@acme.com",
      storedName: "Globex Corporation",
      storedEmail: "billing@acme.com",
    });
  });

  it("returns found_by_name_exact when name matches and no email submitted", async () => {
    // Step 1: email query returns empty (no email submitted)
    // Step 2: name query returns a match with a stored email
    vi.mocked(qboRequest).mockResolvedValueOnce(
      nameQueryResponse({ id: "cust-200", displayName: "Acme Inc", email: "old@acme.com" }),
    );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "", // no email
    );

    expect(result.action).toBe("found_by_name_exact");
    expect(result.customerId).toBe("cust-200");
  });

  it("returns found_by_name_exact when name matches and stored customer has no email", async () => {
    // Step 1: email lookup with submitted email returns no match
    // Step 2: name lookup matches a customer with no stored email
    vi.mocked(qboRequest)
      .mockResolvedValueOnce(emptyQueryResponse())
      .mockResolvedValueOnce(
        nameQueryResponse({ id: "cust-201", displayName: "Acme Inc", email: null }),
      );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "new@acme.com",
    );

    expect(result.action).toBe("found_by_name_exact");
    expect(result.customerId).toBe("cust-201");
  });

  it("returns ambiguous_name_only when name matches but emails differ", async () => {
    vi.mocked(qboRequest)
      .mockResolvedValueOnce(emptyQueryResponse()) // email query: no match
      .mockResolvedValueOnce(
        nameQueryResponse({
          id: "cust-202",
          displayName: "Acme Inc",
          email: "old-billing@acme.com",
        }),
      );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme Inc",
      "new-billing@acme.com",
    );

    expect(result.action).toBe("ambiguous_name_only");
    expect(result.customerId).toBe("cust-202");
    expect(result.matchDetails).toEqual({
      submittedName: "Acme Inc",
      submittedEmail: "new-billing@acme.com",
      storedName: "Acme Inc",
      storedEmail: "old-billing@acme.com",
    });
  });

  it("returns created_new when neither email nor name matches", async () => {
    vi.mocked(qboRequest)
      .mockResolvedValueOnce(emptyQueryResponse()) // email query: empty
      .mockResolvedValueOnce(emptyQueryResponse()) // name query: empty
      .mockResolvedValueOnce(createResponse("cust-new-300")); // create response

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "New Co Inc",
      "billing@newco.com",
    );

    expect(result.action).toBe("created_new");
    expect(result.customerId).toBe("cust-new-300");
    expect(result.matchDetails).toBeUndefined();
  });

  it("returns created_new when no email submitted and no name match", async () => {
    vi.mocked(qboRequest)
      .mockResolvedValueOnce(emptyQueryResponse()) // name query: empty
      .mockResolvedValueOnce(createResponse("cust-new-301"));

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "New Co Inc",
      "",
    );

    expect(result.action).toBe("created_new");
    expect(result.customerId).toBe("cust-new-301");
  });

  it("normalizes names when comparing — 'Acme, Inc.' email-matches 'Acme Inc'", async () => {
    // Email matches; stored name is "Acme Inc", submitted name is "Acme, Inc."
    // After normalization both become "acme inc" so this is found_by_email
    vi.mocked(qboRequest).mockResolvedValueOnce(
      emailQueryResponse({ id: "cust-400", displayName: "Acme Inc", email: "billing@acme.com" }),
    );

    const result = await qbo.findOrCreateCustomer(
      MOCK_DB,
      COMPANY_ID,
      CONTACT_ID,
      "Acme, Inc.", // normalized form matches stored name's normalized form
      "billing@acme.com",
    );

    expect(result.action).toBe("found_by_email");
  });
});
