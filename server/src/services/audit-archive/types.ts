// Phase 6 6c archive-writer types. Per locked Decisions:
//   - CC1: full-row JSONL — each archived row carries every activity_log column
//     (litigation defense; missing fields years later are unrecoverable).
//   - S/T-revised: point-in-time identity snapshots (companyNameSnapshot,
//     agentNameSnapshot) captured at write time travel with the row.

export interface ArchivedActivityRow {
  id: string;
  companyId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  status: string;
  companyNameSnapshot: string | null;
  agentNameSnapshot: string | null;
  createdAt: string; // ISO 8601 — Date round-tripped through JSON
}

// Per AA2: dedicated archive encryption material with its own scheme tag so
// archive blobs are never confused with secrets-module blobs at the type level.
// Same AES-256-GCM crypto pattern as local_encrypted_v1, different key.
export interface EncryptedArchiveMaterial {
  scheme: "archive_v1";
  iv: string; // base64, 12 bytes (GCM)
  tag: string; // base64, 16 bytes (GCM auth tag)
  ciphertext: string; // base64
}

export interface ArchiveWindow {
  // ISO 8601 strings. Inclusive lower / exclusive upper bound semantics
  // matching `createdAt >= from AND createdAt < to`.
  from?: string;
  to?: string;
}

export interface ArchiveResult {
  // null when no rows were archived (empty-archive guard — see Decision-BB2
  // round-trip-testable design + the empty-archive case in audit-archive.test).
  objectKey: string | null;
  rowCount: number;
  sha256: string | null;
  byteSize: number;
}
