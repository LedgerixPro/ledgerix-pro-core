import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { requireAgentPermission } from "./require-agent-permission.js";

const hasPermissionMock = vi.fn();

vi.mock("../services/access.js", () => ({
  accessService: () => ({
    hasPermission: hasPermissionMock,
  }),
}));

const mockDb = {} as Db;

function makeReq(actor: Express.Request["actor"]): Request {
  return { actor } as Request;
}

function makeRes(): Response {
  return {} as Response;
}

describe("requireAgentPermission", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("agent WITH grant → next() called; hasPermission called with (companyId, 'agent', agentId, key)", async () => {
    hasPermissionMock.mockResolvedValue(true);
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:write_category");

    await mw(
      makeReq({ type: "agent", agentId: "agent-1", companyId: "company-1" }),
      makeRes(),
      next as NextFunction,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(hasPermissionMock).toHaveBeenCalledOnce();
    expect(hasPermissionMock).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-1",
      "accounting:write_category",
    );
  });

  it("agent WITHOUT grant → throws forbidden (403) with permissionKey in message; next() not called", async () => {
    hasPermissionMock.mockResolvedValue(false);
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:create_payment");

    await expect(
      mw(
        makeReq({ type: "agent", agentId: "agent-1", companyId: "company-1" }),
        makeRes(),
        next as NextFunction,
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("accounting:create_payment"),
    });

    expect(next).not.toHaveBeenCalled();
  });

  it("non-agent actor (type 'board') → pass-through; hasPermission NOT called (Decision C)", async () => {
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:write_category");

    await mw(
      makeReq({ type: "board", userId: "user-1" }),
      makeRes(),
      next as NextFunction,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });

  it("non-agent actor (type 'none') → pass-through; hasPermission NOT called (Decision C)", async () => {
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:write_category");

    await mw(
      makeReq({ type: "none" }),
      makeRes(),
      next as NextFunction,
    );

    expect(next).toHaveBeenCalledOnce();
    expect(hasPermissionMock).not.toHaveBeenCalled();
  });

  it("agent missing agentId → throws forbidden; hasPermission NOT called (defensive)", async () => {
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:write_category");

    await expect(
      mw(
        makeReq({ type: "agent", companyId: "company-1" }),
        makeRes(),
        next as NextFunction,
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agent identity incomplete",
    });

    expect(hasPermissionMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("agent missing companyId → throws forbidden; hasPermission NOT called (defensive)", async () => {
    const next = vi.fn();
    const mw = requireAgentPermission(mockDb, "accounting:write_category");

    await expect(
      mw(
        makeReq({ type: "agent", agentId: "agent-1" }),
        makeRes(),
        next as NextFunction,
      ),
    ).rejects.toMatchObject({
      status: 403,
      message: "Agent identity incomplete",
    });

    expect(hasPermissionMock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
