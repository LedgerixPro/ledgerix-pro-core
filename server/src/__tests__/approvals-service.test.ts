import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
  // Phase 6 6a-AUDIT X1: identity resolution helper.
  getById: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

// Phase 6 6a-AUDIT mocks — used by the replay-side logActivity flow tests.
const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockExecuteApprovedAccountingWrite = vi.hoisted(() => vi.fn());
const mockIsAccountingApprovalType = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/companies.js", () => ({
  companyService: vi.fn(() => mockCompanyService),
}));

vi.mock("../services/accounting/write-approvals.js", () => ({
  executeApprovedAccountingWrite: mockExecuteApprovedAccountingWrite,
  isAccountingApprovalType: mockIsAccountingApprovalType,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Phase 6 6a-AUDIT replay-side (W1/U3/X1):
// approve() logActivity's the accounting write outcome.
// Decisions:
//   W1 — log in approve() after executeApprovedAccountingWrite returns
//   U3 — log both write_executed (success) AND write_failed_replay (failure);
//        skip stub_logged / skip_unknown_type (not real book-touches)
//   X1 — resolve company/agent name ONCE per approval via getById helpers,
//        pass via the optional companyNameSnapshot / agentNameSnapshot fields
//        shipped in commit c64bf177.
// ============================================================================

function createAccountingApproval(): ApprovalRecord {
  return {
    id: "approval-acct-1",
    companyId: "company-acct-1",
    type: "accounting.transaction.category_with_unknown_previous",
    status: "pending",
    payload: { someField: "value" },
    requestedByAgentId: "agent-acct-1",
  };
}

describe("approvalService.approve — Phase 6 6a-AUDIT replay-side logActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);

    // All accounting-type tests run with the dispatcher's gate predicate true.
    mockIsAccountingApprovalType.mockReturnValue(true);
    // Default identity resolution for X1.
    mockCompanyService.getById.mockResolvedValue({
      id: "company-acct-1",
      name: "Acme Books Inc",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-acct-1",
      name: "Reconciliation Agent",
    });
  });

  it("write_executed → logActivity called with status=success and resolved snapshots (W1/X1)", async () => {
    const approved = { ...createAccountingApproval(), status: "approved" };
    const dbStub = createDbStub([[createAccountingApproval()]], [approved]);

    mockExecuteApprovedAccountingWrite.mockResolvedValueOnce({
      executed: true,
      action: "write_executed",
      upstreamResult: {
        platform: "quickbooks",
        txnType: "Purchase",
        txnId: "qbo-txn-1",
        previousAccountRef: "60100",
        newAccountRef: "60200",
      },
      message: "Category updated",
    });

    const svc = approvalService(dbStub.db as any);
    const res = await svc.approve("approval-acct-1", "board-user-1", "ok");

    expect(res.applied).toBe(true);

    // Identity resolved once.
    expect(mockCompanyService.getById).toHaveBeenCalledTimes(1);
    expect(mockCompanyService.getById).toHaveBeenCalledWith("company-acct-1");
    expect(mockAgentService.getById).toHaveBeenCalledTimes(1);
    expect(mockAgentService.getById).toHaveBeenCalledWith("agent-acct-1");

    // logActivity called with the success shape.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [, input] = mockLogActivity.mock.calls[0];
    expect(input).toMatchObject({
      companyId: "company-acct-1",
      actorType: "agent",
      actorId: "agent-acct-1",
      action: "accounting.write.executed",
      entityType: "approval",
      entityId: "approval-acct-1",
      agentId: "agent-acct-1",
      companyNameSnapshot: "Acme Books Inc",
      agentNameSnapshot: "Reconciliation Agent",
      status: "success",
    });
    expect(input.details).toMatchObject({
      approvalId: "approval-acct-1",
      approvalType: "accounting.transaction.category_with_unknown_previous",
      decidedByUserId: "board-user-1",
      message: "Category updated",
      upstreamResult: {
        platform: "quickbooks",
        txnId: "qbo-txn-1",
        previousAccountRef: "60100",
        newAccountRef: "60200",
      },
    });
  });

  it("write_failed_replay → logActivity called with status=failure and the failure message (W1/U3)", async () => {
    const approved = { ...createAccountingApproval(), status: "approved" };
    const dbStub = createDbStub([[createAccountingApproval()]], [approved]);

    mockExecuteApprovedAccountingWrite.mockResolvedValueOnce({
      executed: false,
      action: "write_failed_replay",
      message: "Transaction still missing on replay",
    });

    const svc = approvalService(dbStub.db as any);
    const res = await svc.approve("approval-acct-1", "board-user-1", "ok");

    expect(res.applied).toBe(true);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const [, input] = mockLogActivity.mock.calls[0];
    expect(input).toMatchObject({
      action: "accounting.write.failed_replay",
      status: "failure",
      entityType: "approval",
      entityId: "approval-acct-1",
    });
    expect(input.details).toMatchObject({
      message: "Transaction still missing on replay",
      upstreamResult: null,
    });
  });

  it("stub_logged → no logActivity row (not a real book-touch, U3)", async () => {
    const approved = { ...createAccountingApproval(), status: "approved" };
    const dbStub = createDbStub([[createAccountingApproval()]], [approved]);

    mockExecuteApprovedAccountingWrite.mockResolvedValueOnce({
      executed: false,
      action: "stub_logged",
      message: "Stub — execution deferred",
    });

    const svc = approvalService(dbStub.db as any);
    const res = await svc.approve("approval-acct-1", "board-user-1", "ok");

    expect(res.applied).toBe(true);
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("skip_unknown_type → no logActivity row (not a real book-touch, U3)", async () => {
    const approved = { ...createAccountingApproval(), status: "approved" };
    const dbStub = createDbStub([[createAccountingApproval()]], [approved]);

    mockExecuteApprovedAccountingWrite.mockResolvedValueOnce({
      executed: false,
      action: "skip_unknown_type",
      message: "Unknown approval type",
    });

    const svc = approvalService(dbStub.db as any);
    const res = await svc.approve("approval-acct-1", "board-user-1", "ok");

    expect(res.applied).toBe(true);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logActivity throwing does NOT roll back / does NOT rethrow (approval still approved)", async () => {
    const approved = { ...createAccountingApproval(), status: "approved" };
    const dbStub = createDbStub([[createAccountingApproval()]], [approved]);

    mockExecuteApprovedAccountingWrite.mockResolvedValueOnce({
      executed: true,
      action: "write_executed",
      upstreamResult: { platform: "quickbooks", txnId: "qbo-txn-1" },
      message: "Category updated",
    });
    mockLogActivity.mockRejectedValueOnce(new Error("audit DB unreachable"));

    const svc = approvalService(dbStub.db as any);
    // Must NOT throw out of approve().
    const res = await svc.approve("approval-acct-1", "board-user-1", "ok");

    expect(res.applied).toBe(true);
    expect(res.approval.status).toBe("approved");
    // logActivity was called (and threw); the catch swallowed it.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });
});
