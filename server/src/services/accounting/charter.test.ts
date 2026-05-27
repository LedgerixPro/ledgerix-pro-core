import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  clientCharterStatus,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  cancelCharter,
  CharterAlreadyExistsError,
  CharterNotFoundError,
  CharterTransitionError,
  getCharterStatus,
  grantCharterToNewClient,
  isCharterForInvoicing,
  recordNonCharterClient,
} from "./charter.js";

// Integration tests for charter service (Q1 LOCKED 2026-05-27 commit 0cf679d6).
//
// These run against real embedded Postgres because the service has multiple
// query shapes (read/insert/update) plus a unique constraint, and the
// state-transition rules are the load-bearing invariant — we want SQL-level
// confidence that the rules hold, not just mock-level. Mirrors the pattern
// established by compare-and-seed.integration.test.ts.
//
// Lifecycle: one Postgres instance per test file; rows cleaned between tests.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const COMPANY_ID = "company-test-1";
const CONTACT_ID = "contact-test-1";

describeEmbeddedPostgres("charter service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-charter-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(clientCharterStatus);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ===========================================================================
  // getCharterStatus
  // ===========================================================================

  describe("getCharterStatus", () => {
    it("returns 'never_charter' when no row exists for the client (default)", async () => {
      const status = await getCharterStatus(db, COMPANY_ID, CONTACT_ID);
      expect(status).toBe("never_charter");
    });

    it("returns 'active' when an active row exists", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      const status = await getCharterStatus(db, COMPANY_ID, CONTACT_ID);
      expect(status).toBe("active");
    });

    it("returns 'cancelled_was_charter' when a cancelled row exists", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      await cancelCharter(db, COMPANY_ID, CONTACT_ID, "Service ended");
      const status = await getCharterStatus(db, COMPANY_ID, CONTACT_ID);
      expect(status).toBe("cancelled_was_charter");
    });

    it("returns 'never_charter' when an explicit never_charter row exists", async () => {
      await recordNonCharterClient(db, COMPANY_ID, CONTACT_ID, "Signed up after charter window closed");
      const status = await getCharterStatus(db, COMPANY_ID, CONTACT_ID);
      expect(status).toBe("never_charter");
    });

    it("scopes lookups to (companyId, ghlContactId) — doesn't leak between clients", async () => {
      // Same companyId, different contactIds — one charter, one not
      await grantCharterToNewClient(db, COMPANY_ID, "contact-A");
      await recordNonCharterClient(db, COMPANY_ID, "contact-B");

      expect(await getCharterStatus(db, COMPANY_ID, "contact-A")).toBe("active");
      expect(await getCharterStatus(db, COMPANY_ID, "contact-B")).toBe("never_charter");

      // Different company, same contactId — independent state
      await grantCharterToNewClient(db, "company-other", "contact-A");
      expect(await getCharterStatus(db, "company-other", "contact-A")).toBe("active");
      // Original company-test-1 / contact-A still active independently
      expect(await getCharterStatus(db, COMPANY_ID, "contact-A")).toBe("active");
    });
  });

  // ===========================================================================
  // isCharterForInvoicing
  // ===========================================================================

  describe("isCharterForInvoicing", () => {
    it("returns true ONLY for 'active' status", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      expect(await isCharterForInvoicing(db, COMPANY_ID, CONTACT_ID)).toBe(true);
    });

    it("returns false for 'cancelled_was_charter' (rule 3: charter lost permanently on cancellation)", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      await cancelCharter(db, COMPANY_ID, CONTACT_ID);
      expect(await isCharterForInvoicing(db, COMPANY_ID, CONTACT_ID)).toBe(false);
    });

    it("returns false for explicit 'never_charter' row", async () => {
      await recordNonCharterClient(db, COMPANY_ID, CONTACT_ID);
      expect(await isCharterForInvoicing(db, COMPANY_ID, CONTACT_ID)).toBe(false);
    });

    it("returns false when no row exists (defaults to never_charter — safe billing default)", async () => {
      expect(await isCharterForInvoicing(db, COMPANY_ID, CONTACT_ID)).toBe(false);
    });
  });

  // ===========================================================================
  // grantCharterToNewClient
  // ===========================================================================

  describe("grantCharterToNewClient", () => {
    it("creates a row with status='active', grantedAt and statusChangedAt set, cancelledAt null", async () => {
      const before = new Date();
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      const after = new Date();

      const rows = await db
        .select()
        .from(clientCharterStatus)
        .where(
          and(
            eq(clientCharterStatus.companyId, COMPANY_ID),
            eq(clientCharterStatus.ghlContactId, CONTACT_ID),
          ),
        );

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("active");
      expect(row.grantedAt).not.toBeNull();
      expect(row.grantedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.grantedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.cancelledAt).toBeNull();
    });

    it("stores reason when provided", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID, "First 10 — Sunday cohort");

      const rows = await db
        .select({ reason: clientCharterStatus.reason })
        .from(clientCharterStatus)
        .where(eq(clientCharterStatus.companyId, COMPANY_ID));

      expect(rows[0].reason).toBe("First 10 — Sunday cohort");
    });

    it("stores reason as null when omitted", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);

      const rows = await db
        .select({ reason: clientCharterStatus.reason })
        .from(clientCharterStatus)
        .where(eq(clientCharterStatus.companyId, COMPANY_ID));

      expect(rows[0].reason).toBeNull();
    });

    it("throws CharterAlreadyExistsError when a row already exists for (companyId, ghlContactId)", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);

      await expect(
        grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID),
      ).rejects.toBeInstanceOf(CharterAlreadyExistsError);
    });
  });

  // ===========================================================================
  // recordNonCharterClient
  // ===========================================================================

  describe("recordNonCharterClient", () => {
    it("creates a row with status='never_charter', grantedAt=null", async () => {
      await recordNonCharterClient(db, COMPANY_ID, CONTACT_ID);

      const rows = await db
        .select()
        .from(clientCharterStatus)
        .where(eq(clientCharterStatus.companyId, COMPANY_ID));

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("never_charter");
      expect(row.grantedAt).toBeNull();
      expect(row.cancelledAt).toBeNull();
    });

    it("throws CharterAlreadyExistsError when a row already exists", async () => {
      await recordNonCharterClient(db, COMPANY_ID, CONTACT_ID);

      await expect(
        recordNonCharterClient(db, COMPANY_ID, CONTACT_ID),
      ).rejects.toBeInstanceOf(CharterAlreadyExistsError);
    });

    it("throws CharterAlreadyExistsError even if existing row has a different status (e.g., active)", async () => {
      // Onboarding race: charter grant + non-charter record attempted for same client
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);

      await expect(
        recordNonCharterClient(db, COMPANY_ID, CONTACT_ID),
      ).rejects.toBeInstanceOf(CharterAlreadyExistsError);
    });
  });

  // ===========================================================================
  // cancelCharter — the load-bearing state-transition enforcement
  // ===========================================================================

  describe("cancelCharter", () => {
    it("transitions active → cancelled_was_charter, sets cancelledAt and statusChangedAt", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);

      const before = new Date();
      await cancelCharter(db, COMPANY_ID, CONTACT_ID, "Client requested cancellation");
      const after = new Date();

      const rows = await db
        .select()
        .from(clientCharterStatus)
        .where(eq(clientCharterStatus.companyId, COMPANY_ID));

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("cancelled_was_charter");
      expect(row.cancelledAt).not.toBeNull();
      expect(row.cancelledAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.cancelledAt!.getTime()).toBeLessThanOrEqual(after.getTime());
      expect(row.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(row.reason).toBe("Client requested cancellation");
      // grantedAt should be PRESERVED (audit trail of original charter grant)
      expect(row.grantedAt).not.toBeNull();
    });

    it("throws CharterNotFoundError when no row exists for the client", async () => {
      await expect(
        cancelCharter(db, COMPANY_ID, CONTACT_ID),
      ).rejects.toBeInstanceOf(CharterNotFoundError);
    });

    it("throws CharterTransitionError when current status is 'cancelled_was_charter' (rule 3: one-way)", async () => {
      await grantCharterToNewClient(db, COMPANY_ID, CONTACT_ID);
      await cancelCharter(db, COMPANY_ID, CONTACT_ID);

      // Second cancellation attempt — should fail
      let caught: unknown;
      try {
        await cancelCharter(db, COMPANY_ID, CONTACT_ID);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CharterTransitionError);
      const transitionErr = caught as CharterTransitionError;
      expect(transitionErr.currentStatus).toBe("cancelled_was_charter");
      expect(transitionErr.attemptedTransition).toBe("cancel charter");
    });

    it("throws CharterTransitionError when current status is 'never_charter' (defends against accidental misuse)", async () => {
      await recordNonCharterClient(db, COMPANY_ID, CONTACT_ID);

      let caught: unknown;
      try {
        await cancelCharter(db, COMPANY_ID, CONTACT_ID);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CharterTransitionError);
      const transitionErr = caught as CharterTransitionError;
      expect(transitionErr.currentStatus).toBe("never_charter");
    });
  });
});
