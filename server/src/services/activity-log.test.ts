import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// Mock instance-settings so getGeneral() returns a known censor setting
// without needing a real db. Hoisted vi.mock factory closes over the spy
// returned via vi.hoisted to keep TDZ-safe across the import chain.
const { getGeneralMock } = vi.hoisted(() => ({
  getGeneralMock: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
vi.mock("./instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: getGeneralMock }),
}));

// Mock live-events so publishLiveEvent is an observable no-op spy.
const { publishLiveEventMock } = vi.hoisted(() => ({
  publishLiveEventMock: vi.fn(),
}));
vi.mock("./live-events.js", () => ({
  publishLiveEvent: publishLiveEventMock,
}));

import { logActivity, type LogActivityInput } from "./activity-log.js";

interface InsertCall {
  values: Record<string, unknown>;
}

function createMockDb() {
  const insertCalls: InsertCall[] = [];
  const selectSpy = vi.fn();

  const db = {
    select: selectSpy,
    insert: vi.fn(() => ({
      values: vi.fn((vals: Record<string, unknown>) => ({
        returning: vi.fn(async () => [{ id: "row-uuid-1" }]),
      })),
    })),
  } as unknown as Db;

  // Capture the values argument from db.insert(...).values(...) by overriding
  // the chain. We re-wire `insert` to record the call shape that the production
  // code uses.
  const insertSpy = vi.fn((_table: unknown) => ({
    values: (vals: Record<string, unknown>) => {
      insertCalls.push({ values: vals });
      return {
        returning: vi.fn(async () => [{ id: "row-uuid-1" }]),
      };
    },
  }));
  (db as unknown as { insert: typeof insertSpy }).insert = insertSpy;

  return { db, insertCalls, selectSpy, insertSpy };
}

const BASE_INPUT: LogActivityInput = {
  companyId: "company-uuid-1",
  actorType: "agent",
  actorId: "agent-uuid-1",
  action: "test.action", // not in ACTIVITY_ACTION_TO_PLUGIN_EVENT — no plugin emit
  entityType: "test_entity",
  entityId: "entity-uuid-1",
  agentId: "agent-uuid-1",
};

describe("logActivity — point-in-time identity snapshots (Phase 6 Decision S / T REVISED)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // resetAllMocks wipes the default implementation set in vi.hoisted; re-prime.
    getGeneralMock.mockResolvedValue({ censorUsernameInLogs: false });
  });

  it("stores supplied companyNameSnapshot + agentNameSnapshot on the inserted row", async () => {
    const { db, insertCalls, selectSpy } = createMockDb();

    await logActivity(db, {
      ...BASE_INPUT,
      companyNameSnapshot: "Acme Books Inc",
      agentNameSnapshot: "Reconciliation Agent",
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values).toMatchObject({
      companyNameSnapshot: "Acme Books Inc",
      agentNameSnapshot: "Reconciliation Agent",
    });

    // Decision T REVISED guarantee: no general fallback lookup.
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("stores null snapshots when omitted AND does not query companies/agents (hot-path-untouched guarantee)", async () => {
    const { db, insertCalls, selectSpy } = createMockDb();

    await logActivity(db, BASE_INPUT);

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values.companyNameSnapshot).toBeNull();
    expect(insertCalls[0].values.agentNameSnapshot).toBeNull();

    // The load-bearing assertion for Decision T REVISED: zero db.select calls,
    // which means zero companies/agents lookups. The 142-site general callers
    // pay no DB cost for the new identity-capture feature.
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("stores null for one snapshot when only the other is supplied", async () => {
    const { db, insertCalls } = createMockDb();

    await logActivity(db, {
      ...BASE_INPUT,
      companyNameSnapshot: "Acme Books Inc",
      // agentNameSnapshot omitted
    });

    expect(insertCalls[0].values.companyNameSnapshot).toBe("Acme Books Inc");
    expect(insertCalls[0].values.agentNameSnapshot).toBeNull();
  });

  it("treats explicit null the same as omitted (no lookup, null stored)", async () => {
    const { db, insertCalls, selectSpy } = createMockDb();

    await logActivity(db, {
      ...BASE_INPUT,
      companyNameSnapshot: null,
      agentNameSnapshot: null,
    });

    expect(insertCalls[0].values.companyNameSnapshot).toBeNull();
    expect(insertCalls[0].values.agentNameSnapshot).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("system-scoped row (companyId null) also stores null snapshots without lookup", async () => {
    const { db, insertCalls, selectSpy } = createMockDb();

    await logActivity(db, {
      ...BASE_INPUT,
      companyId: null,
      agentId: null,
    });

    expect(insertCalls[0].values.companyNameSnapshot).toBeNull();
    expect(insertCalls[0].values.agentNameSnapshot).toBeNull();
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
