import { and, asc, eq, gte, lt } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";
import { badRequest } from "../../errors.js";
import {
  encryptArchive,
  decryptArchive,
  loadArchiveMasterKey,
} from "./crypto.js";
import type {
  ArchivedActivityRow,
  ArchiveResult,
  ArchiveWindow,
  EncryptedArchiveMaterial,
} from "./types.js";

// Phase 6 6c archive-writer + retrieval. Decisions in play:
//   AA2 — dedicated archive master key (PAPERCLIP_ARCHIVE_MASTER_KEY)
//   BB2 — writer + retrieval shipped together (round-trip testable)
//   CC1 — full-row JSONL (every activity_log column captured)
//   S/T-revised — point-in-time snapshots travel with the row
//   P1 (key path) — {companyId}/audit-archive/{year}/{month}/...

const NAMESPACE = "audit-archive";

function rowToArchived(row: typeof activityLog.$inferSelect): ArchivedActivityRow {
  return {
    id: row.id,
    companyId: row.companyId,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    agentId: row.agentId,
    runId: row.runId,
    details: (row.details as Record<string, unknown> | null) ?? null,
    status: row.status,
    companyNameSnapshot: row.companyNameSnapshot,
    agentNameSnapshot: row.agentNameSnapshot,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeJsonl(rows: ArchivedActivityRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function parseJsonl(text: string): ArchivedActivityRow[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ArchivedActivityRow);
}

async function readStreamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function describeWindow(window: ArchiveWindow | undefined): string {
  if (!window) return "all";
  const from = window.from ?? "any";
  const to = window.to ?? "any";
  return `${from}_to_${to}`;
}

export interface AuditArchiveService {
  /**
   * Archive a company's activity_log rows for a window. Per Decision BB2 and
   * the litigation contract, the writer + retrieval are paired (see readArchive).
   *
   * Empty-archive semantics: if the company has zero rows in the window, returns
   * `{objectKey: null, rowCount: 0, sha256: null, byteSize: 0}` rather than
   * calling putFile (which rejects empty buffers). The 6a-0 delete-hook can
   * call this for any tenant without crashing on tenants with no audit history.
   */
  archiveActivityForCompany(
    companyId: string,
    window?: ArchiveWindow,
  ): Promise<ArchiveResult>;

  /**
   * Read back + decrypt a previously-written archive. The inverse of archiveActivityForCompany.
   * The storage layer enforces tenant isolation (ensureCompanyPrefix); a mismatched
   * companyId throws.
   */
  readArchive(companyId: string, objectKey: string): Promise<ArchivedActivityRow[]>;
}

export function auditArchiveService(
  db: Db,
  storage: StorageService,
): AuditArchiveService {
  const masterKey = loadArchiveMasterKey();

  async function fetchRows(
    companyId: string,
    window: ArchiveWindow | undefined,
  ): Promise<ArchivedActivityRow[]> {
    const conditions = [eq(activityLog.companyId, companyId)];
    if (window?.from) {
      conditions.push(gte(activityLog.createdAt, new Date(window.from)));
    }
    if (window?.to) {
      conditions.push(lt(activityLog.createdAt, new Date(window.to)));
    }
    const rows = await db
      .select()
      .from(activityLog)
      .where(and(...conditions))
      .orderBy(asc(activityLog.createdAt));
    return rows.map(rowToArchived);
  }

  return {
    async archiveActivityForCompany(companyId, window) {
      if (!companyId || companyId.trim().length === 0) {
        throw badRequest("companyId is required");
      }
      const rows = await fetchRows(companyId, window);
      if (rows.length === 0) {
        return { objectKey: null, rowCount: 0, sha256: null, byteSize: 0 };
      }
      const jsonl = serializeJsonl(rows);
      const material = encryptArchive(masterKey, jsonl);
      const body = Buffer.from(JSON.stringify(material), "utf8");
      const result = await storage.putFile({
        companyId,
        namespace: NAMESPACE,
        originalFilename: `audit-${describeWindow(window)}.jsonl.enc`,
        contentType: "application/octet-stream",
        body,
      });
      return {
        objectKey: result.objectKey,
        rowCount: rows.length,
        sha256: result.sha256,
        byteSize: result.byteSize,
      };
    },

    async readArchive(companyId, objectKey) {
      // storage.getObject enforces ensureCompanyPrefix — a mismatched
      // companyId throws before any read happens (tenant isolation).
      const obj = await storage.getObject(companyId, objectKey);
      const stored = await readStreamToString(obj.stream);
      let material: EncryptedArchiveMaterial;
      try {
        material = JSON.parse(stored) as EncryptedArchiveMaterial;
      } catch {
        throw badRequest("Stored archive is not valid JSON");
      }
      const plaintext = decryptArchive(masterKey, material);
      // sha256 of plaintext is recomputable here if a caller wants to verify
      // against an out-of-band integrity record — not asserted at read time.
      void createHash;
      return parseJsonl(plaintext);
    },
  };
}

// Re-export the type-level surface so consumers can `import type` from "./index.js".
export type { ArchivedActivityRow, ArchiveResult, ArchiveWindow } from "./types.js";
