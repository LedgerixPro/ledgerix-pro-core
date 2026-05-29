import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "@paperclipai/db";

// Phase 6 6a-0 delete-hook tests (DD3/EE3). Focused on the load-bearing
// invariants:
//   - DD3: archive scope is companies.remove() ONLY. (Agent-deletion isolation
//     is verified separately by absence of the import in agents.ts; see the
//     last test in this file.)
//   - EE3: archive runs BEFORE the delete transaction; archive-FAILURE ABORTS
//     the deletion — the transaction body must NEVER run when the archive
//     throws. This is the load-bearing "never proceed-and-lose" guarantee.
//
// Crypto / real-storage round-trip is covered by audit-archive.test.ts.
// Here we mock the audit-archive boundary so we can assert ordering,
// failure-propagation, and the empty-company path.

const archiveActivityMock = vi.hoisted(() => vi.fn());
const auditArchiveServiceMock = vi.hoisted(() =>
  vi.fn(() => ({ archiveActivityForCompany: archiveActivityMock })),
);
const getStorageServiceMock = vi.hoisted(() => vi.fn(() => ({ id: "fake-storage" })));

vi.mock("./audit-archive/index.js", () => ({
  auditArchiveService: auditArchiveServiceMock,
}));
vi.mock("../storage/index.js", () => ({
  getStorageService: getStorageServiceMock,
}));

import { companyService } from "./companies.js";

interface OrderingState {
  transactionCalled: boolean;
  transactionCalledAfterArchive: boolean;
}

function createFakeDb(state: OrderingState): Db {
  const deletedCompany = { id: "company-1", name: "Test Co" };

  const txDelete = vi.fn(() => ({
    where: vi.fn(() => ({
      returning: vi.fn(async () => [deletedCompany]),
    })),
  }));
  const tx = { delete: txDelete };

  const db: unknown = {
    transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      state.transactionCalled = true;
      // EE3 ordering check: at the moment the transaction body begins,
      // the archive must have already resolved (it was awaited before).
      if (archiveActivityMock.mock.calls.length > 0) {
        state.transactionCalledAfterArchive = true;
      }
      return await cb(tx);
    }),
  };
  return db as Db;
}

describe("companies.remove() — Phase 6 6a-0 archive-before-delete hook (DD3/EE3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    archiveActivityMock.mockResolvedValue({
      objectKey: "company-1/audit-archive/2026/05/29/abc-audit-all.jsonl.enc",
      rowCount: 5,
      sha256: "deadbeef".repeat(8),
      byteSize: 1234,
    });
    auditArchiveServiceMock.mockReturnValue({
      archiveActivityForCompany: archiveActivityMock,
    });
    getStorageServiceMock.mockReturnValue({ id: "fake-storage" });
  });

  it("archive runs BEFORE the delete transaction, then deletion proceeds (happy path)", async () => {
    const state: OrderingState = { transactionCalled: false, transactionCalledAfterArchive: false };
    const db = createFakeDb(state);

    const result = await companyService(db).remove("company-1");

    // Archive was called with the company id.
    expect(archiveActivityMock).toHaveBeenCalledTimes(1);
    expect(archiveActivityMock).toHaveBeenCalledWith("company-1");

    // Delete transaction ran AFTER the archive completed.
    expect(state.transactionCalled).toBe(true);
    expect(state.transactionCalledAfterArchive).toBe(true);

    // Return value preserved (deleted company row).
    expect(result).toEqual({ id: "company-1", name: "Test Co" });
  });

  it("EE3 INVARIANT: archive FAILURE aborts deletion (transaction NOT called, error propagates) — load-bearing 'never proceed-and-lose'", async () => {
    archiveActivityMock.mockRejectedValueOnce(new Error("storage down — archive failed"));
    const state: OrderingState = { transactionCalled: false, transactionCalledAfterArchive: false };
    const db = createFakeDb(state);

    await expect(companyService(db).remove("company-1")).rejects.toThrow("storage down — archive failed");

    // Archive was attempted.
    expect(archiveActivityMock).toHaveBeenCalledTimes(1);

    // CRITICAL: the delete transaction NEVER ran. This is the EE3 invariant —
    // if this assertion ever fails, the arc has silently lost the record it
    // exists to preserve.
    expect(state.transactionCalled).toBe(false);
    expect(state.transactionCalledAfterArchive).toBe(false);
  });

  it("empty company (objectKey: null, rowCount: 0) → archive succeeds, delete still proceeds", async () => {
    archiveActivityMock.mockResolvedValueOnce({
      objectKey: null,
      rowCount: 0,
      sha256: null,
      byteSize: 0,
    });
    const state: OrderingState = { transactionCalled: false, transactionCalledAfterArchive: false };
    const db = createFakeDb(state);

    const result = await companyService(db).remove("empty-company");

    expect(archiveActivityMock).toHaveBeenCalledTimes(1);
    expect(archiveActivityMock).toHaveBeenCalledWith("empty-company");
    expect(state.transactionCalled).toBe(true);
    expect(state.transactionCalledAfterArchive).toBe(true);
    expect(result).toEqual({ id: "company-1", name: "Test Co" });
  });

  it("DD3: agents.ts does NOT import the audit-archive service (agent-delete is NOT hooked)", async () => {
    // Compile-time / static-text guard: ensure agents.ts doesn't accidentally
    // grow an import of the audit-archive service. The DD3 ACCEPTED GAP is
    // that agent operational rows are destroyed un-archived; this test exists
    // to make adding that hook a deliberate edit (someone would need to add
    // the import AND delete this guard test).
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const agentsFile = readFileSync(
      path.resolve(__dirname, "agents.ts"),
      "utf8",
    );
    expect(agentsFile).not.toContain("audit-archive");
    expect(agentsFile).not.toContain("auditArchiveService");
  });
});
