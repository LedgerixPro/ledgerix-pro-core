import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import type { PermissionKey } from "@paperclipai/shared";
import { accessService } from "../services/access.js";
import { forbidden } from "../errors.js";

export function requireAgentPermission(db: Db, permissionKey: PermissionKey): RequestHandler {
  const access = accessService(db);
  return async (req, _res, next) => {
    if (req.actor.type !== "agent") {
      next();
      return;
    }
    const { agentId, companyId } = req.actor;
    if (!agentId || !companyId) {
      throw forbidden("Agent identity incomplete");
    }
    const allowed = await access.hasPermission(companyId, "agent", agentId, permissionKey);
    if (!allowed) {
      throw forbidden(`Agent not permitted: ${permissionKey}`);
    }
    next();
  };
}
