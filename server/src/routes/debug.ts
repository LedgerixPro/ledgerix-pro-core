import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";

// Same shared-secret pattern as ledgerix-dashboard. Constant-time compare.
function requireDashboardSecret(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.DASHBOARD_SECRET;
  if (!expected) {
    res.status(500).json({ error: "DASHBOARD_SECRET not configured" });
    return;
  }
  const provided = req.get("x-dashboard-secret");
  if (!provided) {
    res.status(401).json({ error: "Missing x-dashboard-secret header" });
    return;
  }
  const e = Buffer.from(expected);
  const p = Buffer.from(provided);
  if (e.length !== p.length || !timingSafeEqual(e, p)) {
    res.status(401).json({ error: "Invalid dashboard secret" });
    return;
  }
  next();
}

function listDir(dir: string): Array<{ name: string; type: "directory" | "file"; size?: number }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => {
    const full = path.join(dir, name);
    try {
      const s = statSync(full);
      return s.isDirectory()
        ? { name, type: "directory" as const }
        : { name, type: "file" as const, size: s.size };
    } catch {
      return { name, type: "file" as const };
    }
  });
}

export function debugRoutes() {
  const router = Router();

  router.use("/debug", requireDashboardSecret);

  router.get("/debug/agents-listing", (_req, res) => {
    const cwd = process.cwd();
    const literalAgentsPath = "/app/agents";
    const cwdAgentsPath = path.resolve(cwd, "agents");

    const literalExists = existsSync(literalAgentsPath);
    const cwdExists = existsSync(cwdAgentsPath);

    const agentDirs = (literalExists ? listDir(literalAgentsPath) : listDir(cwdAgentsPath))
      .filter((e) => e.type === "directory")
      .map((e) => {
        const base = literalExists ? literalAgentsPath : cwdAgentsPath;
        return { name: e.name, files: listDir(path.join(base, e.name)).map((f) => f.name) };
      });

    logger.info({ cwd, literalExists, cwdExists }, "Debug agents-listing requested");

    res.json({
      cwd,
      paths: {
        literal: { path: literalAgentsPath, exists: literalExists },
        cwdRelative: { path: cwdAgentsPath, exists: cwdExists },
      },
      topLevelOfApp: existsSync("/app") ? listDir("/app") : null,
      agents: agentDirs,
    });
  });

  return router;
}
