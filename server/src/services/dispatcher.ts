import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Priority = "P1" | "P2" | "P3";

export interface WorkspaceEntry {
  locationId: string;
  companyId: string;
  companyName: string;
}

interface WorkspaceRegistry {
  workspaces: WorkspaceEntry[];
}

export interface RoutingResult {
  timestamp: string;
  locationId: string;
  eventType: string;
  workspaceId: string;
  companyName: string | null;
  priority: Priority | null;
  targetAgent: string | null;
  routed: boolean;
}

// ---------------------------------------------------------------------------
// Routing tables
// ---------------------------------------------------------------------------

const PRIORITY_MAP: Record<string, Priority> = {
  // P1 — critical, requires immediate escalation
  connection_error: "P1",
  fraud_flag: "P1",
  budget_threshold: "P1",
  reconciliation_anomaly: "P1",
  // P2 — standard business events
  "contact.created": "P2",
  "contact.updated": "P2",
  "contact.sdr_ready": "P1",
  "contact.replied": "P1",
  "opportunity.won": "P1",
  "opportunity.lost": "P1",
  "diagnostic.submitted": "P2",
  "opportunity.stageChanged": "P2",
  "form.submitted": "P2",
  new_transaction: "P2",
  "invoice.paid": "P1",
  "invoice.overdue": "P1",
  "accounting.stale": "P1",
  "nps.low": "P1",
  "bill.due": "P1",
  // P3 — informational / low urgency
  informational: "P3",
  status_change: "P3",
};

const AGENT_MAP: Record<string, string> = {
  connection_error: "Dispatcher",
  fraud_flag: "Sentinel",
  budget_threshold: "CFO",
  reconciliation_anomaly: "Reconciliation Agent",
  "contact.created": "Onboarding",
  "contact.updated": "Onboarding",
  "contact.sdr_ready": "SDR",
  "contact.replied": "SDR",
  "opportunity.won": "Client Success Manager",
  "opportunity.lost": "Client Success Manager",
  "diagnostic.submitted": "Onboarding",
  "opportunity.stageChanged": "Client Success Manager",
  "form.submitted": "Onboarding",
  new_transaction: "Sentinel",
  "invoice.paid": "AR Specialist",
  "invoice.overdue": "Client Health Monitor",
  "accounting.stale": "Client Health Monitor",
  "nps.low": "Client Health Monitor",
  "bill.due": "AP Specialist",
  informational: "ops-agent",
  status_change: "ops-agent",
};

// ---------------------------------------------------------------------------
// Registry loader
// ---------------------------------------------------------------------------

const REGISTRY_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../config/workspace-registry.json",
);

let registryCache: WorkspaceRegistry | null = null;

function loadRegistry(): WorkspaceRegistry {
  if (registryCache) return registryCache;

  if (!existsSync(REGISTRY_PATH)) {
    logger.warn({ path: REGISTRY_PATH }, "workspace-registry.json not found; treating all locations as unknown");
    registryCache = { workspaces: [] };
    return registryCache;
  }

  try {
    const raw = readFileSync(REGISTRY_PATH, "utf-8");
    registryCache = JSON.parse(raw) as WorkspaceRegistry;
    logger.info({ count: registryCache.workspaces.length }, "Loaded GHL workspace registry");
  } catch (err) {
    logger.error({ err, path: REGISTRY_PATH }, "Failed to parse workspace-registry.json; treating all locations as unknown");
    registryCache = { workspaces: [] };
  }

  return registryCache;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function route(locationId: string, eventType: string): RoutingResult {
  const registry = loadRegistry();
  const workspace = registry.workspaces.find((w) => w.locationId === locationId);

  const workspaceId = workspace?.companyId ?? "UNKNOWN_WORKSPACE";
  const companyName = workspace?.companyName ?? null;
  const priority = PRIORITY_MAP[eventType] ?? null;
  const targetAgent = AGENT_MAP[eventType] ?? null;
  const routed = workspace !== undefined && priority !== null;

  const result: RoutingResult = {
    timestamp: new Date().toISOString(),
    locationId,
    eventType,
    workspaceId,
    companyName,
    priority,
    targetAgent,
    routed,
  };

  logger.info(
    {
      timestamp: result.timestamp,
      locationId,
      workspaceId,
      priority,
      eventType,
      targetAgent,
      routed,
    },
    "GHL dispatch routing decision",
  );

  return result;
}

export const dispatcher = { route };
